/**
 * Path: server/src/sessions/thread.ts
 * Used by: server/src/sessions/index.ts (Thread DO, reached from sessions/{catalog,message-routes,read-routes}.ts).
 * Purpose: One session: owns its PiHarness and wires model credentials, tools, message admission, cancellation and the read views.
 */
import {
  CancelRunRequest,
  CompactRequest,
  PageQuery,
  Session,
  SubmitMessageRequest,
  WorkspaceId,
} from '@cloud-swe/protocol';
import { DecideApprovalRequest } from '@cloud-swe/protocol/git';
import { SessionCreation } from '@cloud-swe/protocol/storage';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import { Harness } from '@earendil-works/pi-durable';
import { PiHarness } from 'agents/harness/pi';
import { Lifecycle } from 'agents/lifecycle';
import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../env';
import { refreshGitAccessIfNeeded } from '../git/access';
import { ApprovalDelivery } from '../git/approval-delivery';
import { type ApprovalHost, decideApproval } from '../git/approval-flow';
import { approvalProjection, fileBlockedPush } from '../git/approvals';
import { registerInitialRepo, startInitialClone } from '../git/initial-repo';
import type { PushCommand } from '../git/pktline.ts';
import { gitAuthorization } from '../git/proxy-auth';
import { listPulls } from '../git/pull-records';
import { branchSuffix } from '../git/receive-pack.ts';
import { readRepos } from '../git/repos';
import { apiError } from '../http';
import { CommandReconciler } from '../tools/command-reconciler';
import { commandOperations } from '../tools/command-records';
import { commandRunState, endCommandsOfStoppedSandbox, reconcileWithin } from '../tools/command-state';
import { environment } from '../tools/environment';
import type { ToolHost } from '../tools/host';
import { interruptCommands } from '../tools/interrupt';
import { KeepAlive } from '../tools/keep-alive';
import { toolRegistry } from '../tools/registry';
import { admitCancellation, executeCancellation } from './cancellation';
import { compactionState } from './compaction';
import { sessionModels } from './credentials';
import { events } from './events';
import { messageState } from './message-state';
import { messageReceipt, submitMessage } from './messages';
import { sandboxReplacedNotice } from './notice';
import { readMessage, readSession, rebindWorkspace, requireSession, writeSession } from './thread-store';
import { history, snapshotFromView } from './transcript';
import { type ResumeResult, sandboxLimitError } from './workspace-lifecycle';

// Admission waits this long for orphans to stop, so a sandbox outage cannot hold a request open.
const RECONCILE_BEFORE_ADMISSION_MS = 10_000;

/** One application session owns exactly one native Pi root conversation. */
export class Thread extends DurableObject<Env> {
  readonly models = sessionModels(this.env, () =>
    this.env.CREDENTIALS.get(this.env.CREDENTIALS.idFromName('personal')).modelKey(),
  );

  readonly harness: PiHarness = new PiHarness({
    harness: ({ storage, context, onWake }) =>
      Harness.open(
        storage,
        {
          models: this.models,
          registry: toolRegistry(this.host),
          env: () => environment(this.host),
          onWake,
          settings: { followUpMode: 'one-at-a-time' },
        },
        context,
      ),
  });

  readonly reconciler = new CommandReconciler(() => this.host);

  readonly keepAlive = new KeepAlive(() => this.host);

  readonly host: ToolHost = {
    env: this.env,
    storage: this.ctx.storage,
    harness: this.harness,
    reconciler: this.reconciler,
  };

  readonly approvalHost: ApprovalHost = {
    storage: this.ctx.storage,
    githubToken: () => this.env.CREDENTIALS.get(this.env.CREDENTIALS.idFromName('personal')).githubToken(),
    deliver: (request) => this.deliverFollowUp(request),
    armDelivery: () => this.approvalDelivery.watch(),
  };

  readonly approvalDelivery = new ApprovalDelivery(() => this.approvalHost);

  readonly lifecycle = Lifecycle.install(this)
    .use(this.harness)
    .use(this.reconciler)
    .use(this.keepAlive)
    .use(this.approvalDelivery);

  async initialize(raw: SessionCreation): Promise<Session> {
    const creation = SessionCreation.parse(raw);
    await this.lifecycle.start();
    const existing = await readSession(this.ctx.storage);

    if (existing !== undefined) return this.getSession();

    const pi = await this.harness.pi();
    const root = await pi.root(BG);

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
      engine: 'pi',
      target: 'cloud',
      runtime: { kind: 'pi-durable', conversationId: String(root.id) },
      model: creation.request.model,
      workspace: { id: creation.workspaceId, provider: this.env.WORKSPACE_BACKEND, state: 'running' },
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

  async submitMessage(raw: SubmitMessageRequest): Promise<Response> {
    await this.lifecycle.start();

    // A retry of an admitted message gets its receipt and never starts, pays for or replaces a sandbox.
    if (!(await readMessage(this.ctx.storage, raw.operationId))) {
      const blocked = await this.readyWorkspace();

      if (blocked) return blocked;
    }

    await reconcileWithin(this.host, RECONCILE_BEFORE_ADMISSION_MS);
    // RPCs are resolved before the gate, because a throw inside it resets the Thread.
    const facts = await this.facts();
    await refreshGitAccessIfNeeded(this.host);

    // Armed before admission, so a crash right after it still leaves the recovered run with a keep-alive. If the
    // message is refused, the job's first tick finds no run and ends.
    await this.keepAlive.watch();

    return this.ctx.blockConcurrencyWhile(async () =>
      submitMessage(this.host, await this.sessionProjection(facts), raw),
    );
  }

  /**
   * Makes the session's sandbox usable before a message is admitted: resumes a stopped one, or replaces a deleted one
   * with a new empty sandbox and queues a notice for the model. Returns the error response when it cannot.
   */
  private async readyWorkspace(): Promise<Response | undefined> {
    const catalog = this.env.CATALOG.get(this.env.CATALOG.idFromName('personal'));
    const session = await requireSession(this.ctx.storage);
    let result: ResumeResult = await catalog.resumeWorkspace(session.id, session.workspace.id);

    if (!result.ok && result.reason === 'expired') {
      const replaced = await catalog.replaceWorkspace(session.id, session.workspace.id);

      if (replaced.ok) {
        await rebindWorkspace(
          this.ctx.storage,
          session,
          WorkspaceId.parse(replaced.workspaceId),
          sandboxReplacedNotice(
            (await readRepos(this.ctx.storage)).map(
              (repo) => `${repo.url} at ${repo.path}, session branches cloud-swe/*-${branchSuffix(session.id)}`,
            ),
          ),
        );
        result = { ok: true, resumed: true };
      } else {
        result = replaced;
      }
    }

    if (!result.ok) {
      return result.reason === 'limit' ? sandboxLimitError(this.env) : apiError('sandbox_not_ready');
    }

    // A stopped or replaced sandbox took its processes with it.
    if (result.resumed) await endCommandsOfStoppedSandbox(this.host);
  }

  async cancelRun(raw: CancelRunRequest): Promise<Response> {
    await this.lifecycle.start();

    const facts = await this.facts();

    const admitted = await this.ctx.blockConcurrencyWhile(async () =>
      admitCancellation(this.ctx.storage, this.harness, await this.sessionProjection(facts), raw),
    );

    if (admitted instanceof Response) return admitted;

    return executeCancellation(this.ctx.storage, this.harness, admitted, (ids) => interruptCommands(this.host, ids));
  }

  async history(query: PageQuery): Promise<Response> {
    const result = await history(this.harness, await this.getSession(), query, await commandOperations(this.host));

    return result instanceof Response ? result : Response.json(result);
  }

  async snapshot(): Promise<Response> {
    const session = await this.getSession();
    const watch = await (await (await this.harness.pi()).root(BG)).watch(BG);

    try {
      return Response.json(
        await snapshotFromView(this.harness, session, watch.value, await commandOperations(this.host)),
      );
    } finally {
      await watch.stop();
    }
  }

  async events(): Promise<Response> {
    await this.lifecycle.start();

    return events(
      this.harness,
      () => this.getSession(),
      () => commandOperations(this.host),
    );
  }

  /** Pi summarizes while the conversation keeps working; progress and failure reach clients through `Session.compaction`. */
  async compact(raw: CompactRequest): Promise<Response> {
    await this.lifecycle.start();
    const { instructions } = CompactRequest.parse(raw);

    if ((await compactionState(this.harness)).compaction) return apiError('compaction_running');
    await (await (await this.harness.pi()).root(BG)).compact(instructions, BG);

    return new Response(null, { status: 202 });
  }

  /** The user's decision on an approval. Only this path executes a ref update or merge. */
  async decideApproval(approvalId: string, raw: DecideApprovalRequest): Promise<Response> {
    await this.lifecycle.start();
    const { decision } = DecideApprovalRequest.parse(raw);

    return decideApproval(this.approvalHost, approvalId, decision);
  }

  /** Admission of an approval result through the normal message path. False means try again later. */
  private async deliverFollowUp(request: SubmitMessageRequest): Promise<boolean> {
    // The same path as a client message: a stopped sandbox resumes and the keep-alive starts.
    const response = await this.submitMessage(request);

    return response.status === 202;
  }

  /** Private RPC for the Git proxy: sends a refused push to the user, and returns the reason git prints. */
  requestBlockedPush(repo: string, command: PushCommand) {
    return fileBlockedPush(this.ctx.storage, repo, command);
  }

  /** Private RPC for the Git proxy: whether this capability token may reach the repository. */
  authorizeGit(token: string, owner: string, repo: string) {
    return gitAuthorization(this.ctx.storage, token, owner, repo);
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

    const workspace = await this.env.CATALOG.get(this.env.CATALOG.idFromName('personal'))
      .workspaceState(saved.id, saved.workspace.id)
      .catch((): Session['workspace']['state'] => 'unreachable');

    return { available: await this.modelAvailable(), workspace };
  }

  /** Whether the configured model has a catalog entry and credentials. An unreachable credential store reads as no. */
  private async modelAvailable(): Promise<boolean> {
    const { model } = await (await (await this.harness.pi()).root(BG)).agent(BG);

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
    const root = await (await this.harness.pi()).root(BG);
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
