/**
 * Path: server/src/sessions/thread.ts
 * Used by: server/src/{env,index}.ts.
 * Purpose: The Thread DO, one per session: owns its PiHarness and wires model credentials, tools, message admission, cancellation and the read views.
 */

import {
  type CancelRunRequest,
  type CompactRequest,
  type PageQuery,
  Session,
  type Snapshot,
  type SubmitMessageRequest,
} from '@cloud-swe/protocol';
import type { AnswerSecretRequest } from '@cloud-swe/protocol/environments';
import type { DecideApprovalRequest } from '@cloud-swe/protocol/git';
import type { AnswerQuestionRequest } from '@cloud-swe/protocol/interaction';
import type { SessionCreation } from '@cloud-swe/protocol/storage';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import { type ConversationView, Harness } from '@earendil-works/pi-durable';
import { PiHarness } from 'agents/harness/pi';
import { Lifecycle } from 'agents/lifecycle';
import { DurableObject } from 'cloudflare:workers';

import { catalogStub, credentialsStub, type Env } from '../env.ts';
import { apiError } from '../errors.ts';
import type { FollowUpHost } from '../follow-ups.ts';
import { gitAuthorization, refreshGitAccessIfNeeded } from '../git/access.ts';
import {
  type ApprovalHost,
  approvalProjection,
  decideApproval,
  deliverApprovals,
  fileBlockedPush,
} from '../git/approvals.ts';
import { registerInitialRepo, startInitialClone } from '../git/clone.ts';
import { listPulls } from '../git/pull-store.ts';
import { branchSuffix, type PushCommand } from '../git/push.ts';
import { readRepos } from '../git/repos.ts';
import { PollingJob } from '../polling-job.ts';
import {
  commandReconciler,
  commandRunState,
  endCommandsOfDeletedSandbox,
  interruptCommands,
  reconcileWithin,
} from '../sandbox/command-lifecycle.ts';
import { commandOperations } from '../sandbox/command-records.ts';
import { networkAuthorization } from '../sandbox/egress.ts';
import { environment } from '../sandbox/environment.ts';
import type { ToolHost } from '../sandbox/host.ts';
import { hasMessage, readSession, rebindWorkspace, requireSession, writeSession } from '../thread-store.ts';
import { answerQuestion, deliverAnswers, questionProjection } from '../tools/questions.ts';
import { toolRegistry } from '../tools/registry.ts';
import {
  answerSecretRequest,
  deliverSecretAnswers,
  type SecretAnswerHost,
  secretRequestProjection,
} from '../tools/secret-requests.ts';
import { readTodos } from '../tools/todo.ts';
import { sandboxLimitError } from '../workspaces/settings.ts';
import { admitCancellation, executeCancellation } from './cancellation.ts';
import { compactionState } from './compaction.ts';
import { events } from './events.ts';
import { keepAliveJob } from './keep-alive.ts';
import { messageReceipt, messageState, submitMessage } from './messages.ts';
import { sessionModels } from './models.ts';
import { sandboxReplacedNotice } from './notice.ts';
import { rootConversation } from './pi.ts';
import { history, snapshotFromView } from './transcript.ts';

// Admission waits this long for orphans to stop, so a sandbox outage cannot hold a request open.
const RECONCILE_BEFORE_ADMISSION_MS = 10_000;

/** One application session owns exactly one native Pi root conversation. */
export class SessionThread extends DurableObject<Env> {
  private readonly models = sessionModels(() => credentialsStub(this.env).modelKey());

  private readonly harness: PiHarness = new PiHarness({
    harness: ({ storage, context, onWake }) =>
      Harness.open(
        storage,
        {
          models: this.models,
          registry: toolRegistry(this.host),
          env: () => environment(this.host),
          onWake,
          settings: { steeringMode: 'all', followUpMode: 'one-at-a-time' },
        },
        context,
      ),
  });

  private readonly reconciler = commandReconciler(() => this.host);

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

  private readonly approvalHost: ApprovalHost = {
    ...this.followUps,
    githubToken: (owner, repo) => credentialsStub(this.env).githubToken(owner, repo),
  };

  private readonly secretHost: SecretAnswerHost = { ...this.followUps, env: this.env };

  /**
   * Delivers server-written follow-ups (approval results, answers) until each is admitted. Delivery is refused while
   * the session is settling or has no model, and can fail when a sandbox will not resume.
   */
  private readonly delivery: PollingJob = new PollingJob({
    capability: 'follow-up-delivery',
    job: 'follow-up-delivery',
    step: async () => {
      const owed = [
        await deliverApprovals(this.followUps),
        await deliverAnswers(this.followUps),
        await deliverSecretAnswers(this.followUps),
      ];

      return owed.some(Boolean);
    },
    everyMs: () => 15_000,
  });

  private readonly lifecycle = Lifecycle.install(this)
    .use(this.harness)
    .use(this.reconciler)
    .use(this.keepAlive)
    .use(this.delivery);

  async initialize(creation: SessionCreation): Promise<Session> {
    await this.lifecycle.start();
    const existing = await readSession(this.ctx.storage);

    if (existing !== undefined) return this.getSession();

    const root = await rootConversation(this.harness);

    // root() reuses the persisted conversation, including after a lost creation receipt.
    await root.configure(
      {
        model: {
          provider: creation.request.model.provider,
          modelId: creation.request.model.id,
        },
      },
      BG,
    );

    const session = Session.parse({
      id: creation.sessionId,
      runtime: { conversationId: String(root.id) },
      model: creation.request.model,
      workspace: { id: creation.workspaceId, provider: this.env.WORKSPACE_BACKEND, state: 'running' },
      environment: creation.request.environment ?? null,
      capabilities: { submitMessage: false, cancelRun: false, tools: [], approvals: false, delegation: false },
      run: { kind: 'idle' },
      createdAt: creation.createdAt,
      updatedAt: creation.createdAt,
    });

    // One write: a session that exists always has the repository it was created with.
    const { repo } = creation.request;

    await this.ctx.storage.transaction(async (tx) => {
      await writeSession(tx, session);

      if (repo) await registerInitialRepo(tx, repo);
    });

    if (repo) await startInitialClone(this.host, repo);

    return this.getSession();
  }

  async submitMessage(request: SubmitMessageRequest): Promise<Response> {
    return this.admit(request);
  }

  /** `system` marks a message the server wrote rather than the user. Private, so no RPC caller can set it. */
  private async admit(request: SubmitMessageRequest, system?: true): Promise<Response> {
    await this.lifecycle.start();

    // A retry of an admitted message gets its receipt and never starts, pays for or replaces a sandbox.
    if (!(await hasMessage(this.ctx.storage, request.operationId))) {
      const blocked = await this.readyWorkspace();

      if (blocked) return blocked;
      // Writes a file, which resumes a paused E2B sandbox, so only after the cap check above.
      await refreshGitAccessIfNeeded(this.host);
    }

    await reconcileWithin(this.host, RECONCILE_BEFORE_ADMISSION_MS);
    // RPCs are resolved before the gate, because a throw inside it resets the Thread.
    const facts = await this.facts();

    // Armed before admission, so a crash right after it still leaves the recovered run with a keep-alive. If the
    // message is refused, the job's first tick finds no run and ends.
    await this.keepAlive.watch();

    const response = await this.ctx.blockConcurrencyWhile(async () =>
      submitMessage(this.host, await this.sessionProjection(facts), request, system),
    );

    this.publish();

    return response;
  }

  /**
   * Makes the session's sandbox usable before a message is admitted: resumes a stopped one, or replaces a deleted one
   * with a new empty sandbox and queues a notice for the model. Returns the error response when it cannot.
   */
  private async readyWorkspace(): Promise<Response | undefined> {
    const session = await requireSession(this.ctx.storage);
    const resumed = await catalogStub(this.env).resumeWorkspace(session.id, session.workspace.id);
    const result = resumed.ok || resumed.reason !== 'expired' ? resumed : await this.replaceWorkspace(session);

    if (result.ok) return undefined;

    return result.reason === 'limit' ? sandboxLimitError(this.env) : apiError('sandbox_not_ready');
  }

  private async replaceWorkspace(session: Session) {
    const replaced = await catalogStub(this.env).replaceWorkspace(session.id, session.workspace.id);

    if (!replaced.ok) return replaced;

    const repos = (await readRepos(this.ctx.storage)).map(
      (repo) => `${repo.url} at ${repo.path}, session branches cloud-swe/*-${branchSuffix(session.id)}`,
    );

    await rebindWorkspace(this.ctx.storage, replaced.workspaceId, sandboxReplacedNotice(repos));
    // The new sandbox has none of the old one's processes.
    await endCommandsOfDeletedSandbox(this.host);

    return replaced;
  }

  async cancelRun(request: CancelRunRequest): Promise<Response> {
    await this.lifecycle.start();

    const facts = await this.facts();

    const admitted = await this.ctx.blockConcurrencyWhile(async () =>
      admitCancellation(this.host, await this.sessionProjection(facts), request),
    );

    if (admitted instanceof Response) return admitted;

    return executeCancellation(this.host, admitted, (ids) => interruptCommands(this.host, ids));
  }

  async history(query: PageQuery): Promise<Response> {
    return history(this.harness, await this.getSession(), query, await commandOperations(this.host));
  }

  private async snapshotOf(view: ConversationView): Promise<Snapshot> {
    return snapshotFromView(this.harness, await this.getSession(), view, await commandOperations(this.host));
  }

  async snapshot(): Promise<Response> {
    const watch = await (await rootConversation(this.harness)).watch(BG);

    try {
      return Response.json(await this.snapshotOf(watch.value));
    } finally {
      await watch.stop();
    }
  }

  async events(): Promise<Response> {
    await this.lifecycle.start();

    return events(this.harness, (view) => this.snapshotOf(view), this.streams);
  }

  /** Sends every connected client a frame for a change Pi doesn't publish. */
  private publish() {
    for (const listener of this.streams) listener();
  }

  /** Pi summarizes while the conversation keeps working; progress and failure reach clients through `Session.compaction`. */
  async compact({ instructions }: CompactRequest): Promise<Response> {
    await this.lifecycle.start();

    if ((await compactionState(this.harness)).compaction) return apiError('compaction_running');
    await (await rootConversation(this.harness)).compact(instructions, BG);

    return new Response(null, { status: 202 });
  }

  /** The user's decision on an approval. Only this path executes a ref update or merge. */
  async decideApproval(approvalId: string, { decision }: DecideApprovalRequest): Promise<Response> {
    await this.lifecycle.start();

    return decideApproval(this.approvalHost, approvalId, decision);
  }

  /** The user's answer to ask_user_question, delivered through the normal message path, which resumes the sandbox. */
  async answerQuestion(questionId: string, answer: AnswerQuestionRequest): Promise<Response> {
    await this.lifecycle.start();

    return answerQuestion(this.followUps, questionId, answer);
  }

  /** The user's answer to request_network_secret. The value goes to the environment, never into this Thread. */
  async answerSecretRequest(requestId: string, answer: AnswerSecretRequest): Promise<Response> {
    await this.lifecycle.start();

    return answerSecretRequest(this.secretHost, requestId, answer);
  }

  /** Admission of an approval result or an answer through the normal message path. False means try again later. */
  private async deliverFollowUp(request: SubmitMessageRequest): Promise<boolean> {
    // The same path as a client message: a stopped sandbox resumes and the keep-alive starts.
    const response = await this.admit(request, true);

    return response.status === 202;
  }

  /** Private RPC for the Git proxy: sends a refused push to the user, and returns the reason git prints. */
  async requestBlockedPush(repo: string, command: PushCommand) {
    const reason = await fileBlockedPush(this.ctx.storage, repo, command);
    this.publish();

    return reason;
  }

  /** Private RPC for the Git proxy: whether this capability token may reach the repository. */
  authorizeGit(token: string, owner: string, repo: string) {
    return gitAuthorization(this.ctx.storage, token, owner, repo);
  }

  /** Private RPC for the network proxy: whether this token may use the session's network secrets, and which ones. */
  authorizeNetwork(token: string) {
    return networkAuthorization(this.host, token);
  }

  async getReceipt(id: string): Promise<Response> {
    await this.lifecycle.start();

    return messageReceipt(this.host, id);
  }

  async getSession(): Promise<Session> {
    await this.lifecycle.start();

    return this.sessionProjection(await this.facts());
  }

  /** Everything the session projection needs from outside this Thread, resolved before any admission gate. */
  private async facts() {
    const saved = await requireSession(this.ctx.storage);

    const workspace = await catalogStub(this.env)
      .workspaceState(saved.id, saved.workspace.id)
      .catch((): Session['workspace']['state'] => 'unreachable');

    return { available: await this.modelAvailable(), workspace };
  }

  /** Whether the configured model has a catalog entry and credentials. An unreachable credential store reads as no. */
  private async modelAvailable(): Promise<boolean> {
    const { model } = await (await rootConversation(this.harness)).agent(BG);

    if (!model || this.models.getModel(model.provider, model.modelId) === undefined) return false;

    return this.models.checkAuth(model.provider).then(
      (auth) => auth !== undefined,
      () => false,
    );
  }

  /** Local storage and Pi reads only, so it is safe inside the admission gate. */
  private async sessionProjection({
    available,
    workspace,
  }: {
    available: boolean;
    workspace: Session['workspace']['state'];
  }): Promise<Session> {
    const saved = await requireSession(this.ctx.storage);
    const root = await rootConversation(this.harness);
    const agent = await root.agent(BG);

    if (!agent.model || String(root.id) !== saved.runtime.conversationId) throw new Error('Missing Pi binding');

    // The transcript already stamps every message, so activity needs no write of its own.
    const recent = await root.entries({ order: 'descending' }, 8, undefined, BG);
    const stamps = recent.items.flatMap((entry) => (entry.model ?? []).map(({ timestamp }) => timestamp));
    const updatedAt = new Date(Math.max(Date.parse(saved.createdAt), ...stamps)).toISOString();

    const native = await messageState(this.host);
    const remote = await commandRunState(this.host);
    const compaction = await compactionState(this.harness);

    return Session.parse({
      ...saved,
      workspace: { ...saved.workspace, state: workspace },
      repos: await readRepos(this.ctx.storage),
      approvals: await approvalProjection(this.ctx.storage),
      pullRequests: await listPulls(this.ctx.storage),
      questions: await questionProjection(this.ctx.storage),
      secretRequests: await secretRequestProjection(this.ctx.storage),
      todos: await readTodos(await this.harness.pi(), root.id),
      updatedAt,
      model: { provider: agent.model.provider, id: agent.model.modelId },
      capabilities: {
        ...saved.capabilities,
        submitMessage: available,
        steerMessage: available,
        queueMessage: available,
        cancelRun: true,
        approvals: true,
        tools: [...new Set([...agent.tools, ...agent.callable].map((tool) => tool.name))],
      },
      ...native,
      ...compaction,
      run: remote ?? native.run,
    });
  }
}
