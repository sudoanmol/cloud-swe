/**
 * Path: server/src/sessions/thread.ts
 * Used by: server/src/{env,index}.ts.
 * Purpose: The Thread DO, one per session: owns its PiHarness and wires model credentials, tools, message admission, cancellation and the read views.
 */

import {
  type ApiErrorCode,
  type CancelRunRequest,
  type CancelRunResponse,
  type CompactRequest,
  type OperationReceipt,
  type PageQuery,
  type RewindRequest,
  type Session,
  type SubmitMessageRequest,
} from '@cloud-swe/protocol';
import type { AnswerSecretRequest } from '@cloud-swe/protocol/environments';
import type { AnswerQuestionRequest } from '@cloud-swe/protocol/interaction';
import type { SessionCreation, StoredImageFile } from '@cloud-swe/protocol/storage';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import { type Conversation, type ConversationView, Harness } from '@earendil-works/pi-durable';
import { PiHarness } from 'agents/harness/pi';
import { Lifecycle } from 'agents/lifecycle';
import { DurableObject } from 'cloudflare:workers';

import { catalogStub, credentialsStub, type Env } from '../env.ts';
import { type ApiFailure, failure, respond, type Result, success } from '../errors.ts';
import type { FollowUpHost } from '../follow-ups.ts';
import { refreshGitAccessIfNeeded, tokenValid } from '../git/access.ts';
import { registerInitialRepo, startInitialClone } from '../git/clone.ts';
import { readRepos } from '../git/repos.ts';
import { PollingJob } from '../polling-job.ts';
import { commandReconciler, interruptCommands, reconcileWithin } from '../sandbox/command-lifecycle.ts';
import { networkAuthorization } from '../sandbox/egress.ts';
import { environment } from '../sandbox/environment.ts';
import type { ToolHost } from '../sandbox/host.ts';
import { hasMessage, readMessage, readSession, requireSession, writeSession } from '../thread-store.ts';
import { answerQuestion, deliverAnswers } from '../tools/questions.ts';
import { toolRegistry } from '../tools/registry.ts';
import { answerSecretRequest, deliverSecretAnswers, type SecretAnswerHost } from '../tools/secret-requests.ts';
import { type AttachmentFile, modelImageUrl, recordUpload, storedFile } from './attachments.ts';
import { admitCancellation, executeCancellation } from './cancellation.ts';
import { startCompaction } from './compaction.ts';
import { rewind } from './conversations.ts';
import { events } from './events.ts';
import { keepAliveJob } from './keep-alive.ts';
import { messageReceipt, submitMessage } from './messages.ts';
import { sessionModels } from './models.ts';
import { FIRST_CONVERSATION, openConversation, requireConversation } from './pi.ts';
import { conversationCommands, sessionProjection } from './projection.ts';
import { movesSummary, summaryWriter } from './summary.ts';
import { conversationState, history } from './transcript.ts';
import { readyWorkspace } from './workspace-ready.ts';

// Admission waits this long for orphans to stop, so a sandbox outage cannot hold a request open.
const RECONCILE_BEFORE_ADMISSION_MS = 10_000;

/**
 * One application session: one Pi harness, whose conversations it addresses by ID. Only the active one, the session's
 * `runtime.conversationId`, takes messages, cancellations and compactions; any can be read.
 */
export class SessionThread extends DurableObject<Env> {
  private readonly models = sessionModels(
    () => credentialsStub(this.env).modelKey(),
    (id) => modelImageUrl({ env: this.env, storage: this.ctx.storage }, id),
  );

  private readonly harness: PiHarness = new PiHarness({
    harness: async ({ storage, context, onWake }) => {
      const pi = await Harness.open(
        storage,
        {
          models: this.models,
          registry: toolRegistry(this.host),
          env: () => environment(this.host),
          onWake,
          settings: { steeringMode: 'all', followUpMode: 'one-at-a-time' },
        },
        context,
      );

      // Pi's commits move the list row while no client watches, a run ending included. Opening writes it too, which
      // repairs a write lost to an eviction.
      pi.subscribeCommits((publication) => {
        if (movesSummary(publication)) this.summary.changed();
      });
      this.summary.changed();

      return pi;
    },
  });

  private readonly reconciler = commandReconciler(
    () => this.host,
    () => this.publish(),
  );

  private readonly keepAlive = keepAliveJob(() => this.host);

  private readonly host: ToolHost = {
    env: this.env,
    storage: this.ctx.storage,
    harness: this.harness,
    reconciler: this.reconciler,
  };

  private readonly streams = new Set<() => void>();

  private readonly followUps: FollowUpHost = {
    storage: this.ctx.storage,
    deliver: (request) => this.deliverFollowUp(request),
    armDelivery: () => this.delivery.watch(),
    changed: () => this.publish(),
  };

  private readonly secretHost: SecretAnswerHost = { ...this.followUps, env: this.env };

  /**
   * Delivers server-written follow-ups (answers, secret request outcomes) until each is admitted. Delivery is refused
   * while the session is settling or has no model, and can fail when a sandbox will not resume.
   */
  private readonly delivery: PollingJob = new PollingJob({
    capability: 'follow-up-delivery',
    job: 'follow-up-delivery',
    step: async () => {
      const owed = [await deliverAnswers(this.followUps), await deliverSecretAnswers(this.followUps)];

      return owed.some(Boolean);
    },
    everyMs: () => 15_000,
  });

  private readonly summary = summaryWriter(this.host, () => this.lifecycle.start());

  private readonly lifecycle = Lifecycle.install(this)
    .use(this.harness)
    .use(this.reconciler)
    .use(this.keepAlive)
    .use(this.delivery)
    .use(this.summary.retry);

  /** The early 404: a Thread that holds no session answers before starting Pi, so an unknown ID writes nothing. */
  private async open(): Promise<ApiFailure | undefined> {
    if ((await readSession(this.ctx.storage)) === undefined) return failure('session_not_found');
    await this.lifecycle.start();

    return undefined;
  }

  /** A request its route refused. An unknown session's 404 still comes first, and Pi isn't started either way. */
  async refuse(code: ApiErrorCode): Promise<Response> {
    const known = (await readSession(this.ctx.storage)) !== undefined;

    return respond(failure(known ? code : 'session_not_found'));
  }

  async initialize(creation: SessionCreation): Promise<Session> {
    await this.lifecycle.start();
    const existing = await readSession(this.ctx.storage);

    if (existing !== undefined) return this.getSession();

    // Pi opened it with the harness, and keeps it after a lost creation receipt.
    const first = await requireConversation(this.harness, FIRST_CONVERSATION);

    await first.configure(
      {
        model: {
          provider: creation.model.provider,
          modelId: creation.model.id,
        },
      },
      BG,
    );

    const session = {
      id: creation.sessionId,
      runtime: { conversationId: FIRST_CONVERSATION },
      model: creation.model,
      workspace: { id: creation.workspaceId },
      environment: creation.request.environment ?? null,
      title: null,
      createdAt: creation.createdAt,
    };

    // One write: a session that exists always has the repository it was created with.
    const { repo } = creation.request;

    await this.ctx.storage.transaction(async (tx) => {
      await writeSession(tx, session);

      if (repo) await registerInitialRepo(tx, repo);
    });

    if (repo) await startInitialClone(this.host, repo);

    return this.getSession();
  }

  // The RPC methods the session routes call answer with HTTP responses, from the domain's results.

  async submitMessage(conversationId: string, request: SubmitMessageRequest): Promise<Response> {
    return respond((await this.open()) ?? (await this.admit(conversationId, request)), 202);
  }

  /** `system` marks a message the server wrote rather than the user. Private, so no RPC caller can set it. */
  private async admit(
    conversationId: string,
    request: SubmitMessageRequest,
    system?: true,
  ): Promise<Result<OperationReceipt>> {
    await this.lifecycle.start();
    const found = await this.conversation(conversationId);

    if (!found.ok) return found;

    // A retry of an admitted message gets its receipt and never starts, pays for or replaces a sandbox; nor does a new
    // message the session would refuse for its conversation.
    if (!(await hasMessage(this.ctx.storage, request.operationId))) {
      const blocked = (await this.inactive(conversationId)) ?? (await readyWorkspace(this.host));

      if (blocked) return blocked;
      // Writes a file, which resumes a paused E2B sandbox, so only after the cap check above.
      await refreshGitAccessIfNeeded(this.host);
    }

    await reconcileWithin(this.host, RECONCILE_BEFORE_ADMISSION_MS);
    // RPCs are resolved before the gate, because a throw inside it resets the Thread.
    const workspace = await this.workspaceState();
    const modelReady = await this.modelAvailable(found.value);

    // Armed before admission, so a crash right after it still leaves the recovered run with a keep-alive. If the
    // message is refused, the job's first tick finds no run and ends.
    await this.keepAlive.watch();

    const result = await this.ctx.blockConcurrencyWhile(async () =>
      submitMessage(
        this.host,
        await sessionProjection(this.host, workspace),
        conversationId,
        request,
        modelReady,
        system,
      ),
    );

    this.publish();

    return result;
  }

  /** Pi's handle on one of this session's conversations, or the 404 for an ID it doesn't have. */
  private async conversation(conversationId: string): Promise<Result<Conversation>> {
    const conversation = await openConversation(this.harness, conversationId);

    return conversation ? success(conversation) : failure('conversation_not_found');
  }

  /** The refusal for a write to a conversation the session has moved off. */
  private async inactive(conversationId: string): Promise<ApiFailure | undefined> {
    const saved = await requireSession(this.ctx.storage);

    return saved.runtime.conversationId === conversationId ? undefined : failure('conversation_not_active');
  }

  async cancelRun(conversationId: string, request: CancelRunRequest): Promise<Response> {
    return respond((await this.open()) ?? (await this.cancel(conversationId, request)), 202);
  }

  private async cancel(conversationId: string, request: CancelRunRequest): Promise<Result<CancelRunResponse>> {
    await this.lifecycle.start();
    const found = await this.conversation(conversationId);

    if (!found.ok) return found;
    const workspace = await this.workspaceState();

    const admitted = await this.ctx.blockConcurrencyWhile(async () =>
      admitCancellation(this.host, await sessionProjection(this.host, workspace), conversationId, request),
    );

    if (!admitted.ok) return admitted;

    if (admitted.value.kind === 'accepted') return success(admitted.value.receipt);

    return executeCancellation(this.host, admitted.value.operation, (ids) => interruptCommands(this.host, ids));
  }

  async history(conversationId: string, query: PageQuery): Promise<Response> {
    const found = (await this.open()) ?? (await this.conversation(conversationId));

    if (!found.ok) return respond(found);
    const commands = await conversationCommands(this.host, conversationId);

    return respond(await history(this.harness, await this.getSession(), conversationId, query, commands));
  }

  /** The conversation as Pi's view shows it. Reads only this Thread's storage and Pi, never another object. */
  private async state(conversationId: string, view: ConversationView, workspace: Session['workspace']['state']) {
    const commands = await conversationCommands(this.host, conversationId);
    const session = await sessionProjection(this.host, workspace);

    return conversationState(this.harness, session, conversationId, view, commands);
  }

  async snapshot(conversationId: string): Promise<Response> {
    const found = (await this.open()) ?? (await this.conversation(conversationId));

    if (!found.ok) return respond(found);
    const watch = await found.value.watch(BG);

    try {
      return Response.json((await this.state(conversationId, watch.value, await this.workspaceState())).snapshot());
    } finally {
      await watch.stop();
    }
  }

  /** The conversation's event stream, resumed after the entry `after` names when it can be. */
  async events(conversationId: string, after?: string): Promise<Response> {
    const found = (await this.open()) ?? (await this.conversation(conversationId));

    if (!found.ok) return respond(found);

    const source = {
      read: (view: ConversationView, workspace: Session['workspace']['state']) =>
        this.state(conversationId, view, workspace),
      workspace: () => this.workspaceState(),
    };

    return events(found.value, source, this.streams, after);
  }

  /** Sends every connected client a frame for a change Pi doesn't publish, and updates the list row. */
  private publish() {
    for (const listener of this.streams) listener();
    this.summary.changed();
  }

  /** Pi summarizes while the conversation keeps working; progress and failure reach clients through `Session.compaction`. */
  async compact(conversationId: string, { instructions }: CompactRequest): Promise<Response> {
    const found = (await this.open()) ?? (await this.conversation(conversationId));
    const refused = found.ok ? await this.inactive(conversationId) : found;

    return respond(refused ?? (await startCompaction(this.harness, conversationId, instructions)), 202);
  }

  /** Going back: under the admission gate, so no message is admitted between the idle check and the move. */
  async rewind(conversationId: string, request: RewindRequest): Promise<Response> {
    const found = (await this.open()) ?? (await this.conversation(conversationId));

    if (!found.ok) return respond(found);
    const workspace = await this.workspaceState();
    const cut = async () => rewind(this.host, await sessionProjection(this.host, workspace), conversationId, request);
    const result = await this.ctx.blockConcurrencyWhile(cut);
    this.publish();

    return respond(result);
  }

  /** The user's answer to ask_user_question, delivered through the normal message path, which resumes the sandbox. */
  async answerQuestion(questionId: string, answer: AnswerQuestionRequest): Promise<Response> {
    const absent = await this.open();

    return absent ? respond(absent) : answerQuestion(this.followUps, questionId, answer);
  }

  /** The user's answer to request_network_secret. The value goes to the environment, never into this Thread. */
  async answerSecretRequest(requestId: string, answer: AnswerSecretRequest): Promise<Response> {
    const absent = await this.open();

    return absent ? respond(absent) : answerSecretRequest(this.secretHost, requestId, answer);
  }

  /**
   * Admission of an answer or a secret request's outcome through the normal message path. False means try again later.
   * It goes to the active conversation, the only one that runs; a retry goes where its admission began, so it is never
   * lost to a conflict or delivered twice.
   */
  private async deliverFollowUp(request: SubmitMessageRequest): Promise<boolean> {
    const admitted = await readMessage(this.ctx.storage, request.operationId);

    const conversationId =
      admitted?.receipt.conversationId ?? (await requireSession(this.ctx.storage)).runtime.conversationId;

    // The same path as a client message: a stopped sandbox resumes and the keep-alive starts.
    return (await this.admit(conversationId, request, true)).ok;
  }

  /** Private RPC for the Git proxy: whether this capability token is valid. */
  authorizeGit(token: string) {
    return tokenValid(this.ctx.storage, token);
  }

  /**
   * Private RPC for the network proxy: whether this token may use the session's network secrets, which ones, and the
   * base repository, whose owner a GitHub call that names no account acts for.
   */
  async authorizeNetwork(token: string) {
    const authorization = await networkAuthorization(this.host, token);

    if (!authorization.ok) return authorization;
    const base = (await readRepos(this.ctx.storage)).find((repo) => repo.base);

    return { ...authorization, baseRepo: base?.url ?? null };
  }

  /** Whether this Thread holds a session, without starting Pi: an upload checks it before writing to R2. */
  async exists(): Promise<boolean> {
    return (await readSession(this.ctx.storage)) !== undefined;
  }

  /** A file the upload route has checked and stored in R2. */
  async recordUpload(id: string, file: AttachmentFile, stored: StoredImageFile): Promise<Response> {
    const absent = await this.open();

    if (!absent) return recordUpload(this.host, id, file, stored);
    await this.env.ATTACHMENTS.delete(stored.key);

    return respond(absent);
  }

  async attachmentFile(id: string, file: AttachmentFile): Promise<Result<StoredImageFile>> {
    return (await this.open()) ?? (await storedFile(this.ctx.storage, id, file));
  }

  async getReceipt(id: string): Promise<Response> {
    return respond((await this.open()) ?? (await messageReceipt(this.host, id)));
  }

  async session(): Promise<Response> {
    return respond((await this.open()) ?? success(await this.getSession()));
  }

  private async getSession(): Promise<Session> {
    await this.lifecycle.start();

    return sessionProjection(this.host, await this.workspaceState());
  }

  /** Renames the session. Errors only through API_ERRORS; the route has checked the title. */
  async rename(title: string): Promise<Response> {
    const absent = await this.open();

    if (absent) return respond(absent);
    const saved = await requireSession(this.ctx.storage);
    await writeSession(this.ctx.storage, { ...saved, title });
    this.publish();

    return respond(success(await this.getSession()));
  }

  /** The one thing the session projection needs from outside this Thread, resolved before any admission gate. */
  private async workspaceState(): Promise<Session['workspace']['state']> {
    const saved = await requireSession(this.ctx.storage);

    return catalogStub(this.env)
      .workspaceState(saved.id, saved.workspace.id)
      .catch((): Session['workspace']['state'] => 'unreachable');
  }

  /**
   * Whether the conversation's configured model has a catalog entry and credentials. An unreachable credential store
   * reads as no.
   */
  private async modelAvailable(conversation: Conversation): Promise<boolean> {
    const { model } = await conversation.agent(BG);

    if (!model || this.models.getModel(model.provider, model.modelId) === undefined) return false;

    return this.models.checkAuth(model.provider).then(
      (auth) => auth !== undefined,
      () => false,
    );
  }
}
