/**
 * Path: server/src/sessions/thread.ts
 * Used by: server/src/sessions/index.ts (Thread DO, reached from sessions/{catalog,message-routes,read-routes}.ts).
 * Purpose: One session: owns its PiHarness and wires model credentials, tools, message admission, cancellation and the read views.
 */
import { CancelRunRequest, PageQuery, Session, SubmitMessageRequest } from '@cloud-swe/protocol';
import { SessionCreation } from '@cloud-swe/protocol/storage';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import { Harness } from '@earendil-works/pi-durable';
import { PiHarness } from 'agents/harness/pi';
import { Lifecycle } from 'agents/lifecycle';
import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../env';
import { CommandReconciler } from '../tools/command-reconciler';
import { commandOperations } from '../tools/command-records';
import { commandRunState, reconcileWithin } from '../tools/command-state';
import { environment } from '../tools/environment';
import type { ToolHost } from '../tools/host';
import { interruptCommands } from '../tools/interrupt';
import { toolRegistry } from '../tools/registry';
import { admitCancellation, executeCancellation } from './cancellation';
import { compactionState } from './compaction';
import { sessionModels } from './credentials';
import { events } from './events';
import { messageState } from './message-state';
import { messageReceipt, submitMessage } from './messages';
import { readSession, requireSession, writeSession } from './thread-store';
import { history, snapshotFromView } from './transcript';

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

  readonly host: ToolHost = {
    env: this.env,
    storage: this.ctx.storage,
    harness: this.harness,
    reconciler: this.reconciler,
  };

  readonly lifecycle = Lifecycle.install(this).use(this.harness).use(this.reconciler);

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

    await writeSession(this.ctx.storage, session);

    return this.getSession();
  }

  async submitMessage(raw: SubmitMessageRequest): Promise<Response> {
    await this.lifecycle.start();
    await reconcileWithin(this.host, RECONCILE_BEFORE_ADMISSION_MS);
    // Credentials are an RPC: resolve them before the gate, because a throw inside it resets the Thread.
    const available = await this.modelAvailable();

    return this.ctx.blockConcurrencyWhile(async () =>
      submitMessage(this.host, await this.sessionProjection(available), raw),
    );
  }

  async cancelRun(raw: CancelRunRequest): Promise<Response> {
    await this.lifecycle.start();

    const available = await this.modelAvailable();

    const admitted = await this.ctx.blockConcurrencyWhile(async () =>
      admitCancellation(this.ctx.storage, this.harness, await this.sessionProjection(available), raw),
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

  async getReceipt(id: string): Promise<Response> {
    await this.lifecycle.start();

    return messageReceipt(this.host, id);
  }

  async getSession(): Promise<Session> {
    await this.lifecycle.start();

    return this.sessionProjection(await this.modelAvailable());
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
  private async sessionProjection(available: boolean): Promise<Session> {
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
      updatedAt,
      model: { provider: agent.model.provider, id: agent.model.modelId },
      capabilities: {
        ...saved.capabilities,
        submitMessage: available,
        steerMessage: available,
        queueMessage: available,
        cancelRun: true,
        tools: [...new Set([...agent.tools, ...agent.callable].map((tool) => tool.name))],
      },
      ...native,
      ...compaction,
      run: remote ?? native.run,
    });
  }
}
