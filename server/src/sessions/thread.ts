import { CancelRunRequest, PageQuery, Session, SubmitMessageRequest } from '@cloud-swe/protocol';
import { SessionCreation } from '@cloud-swe/protocol/storage';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import { Harness } from '@earendil-works/pi-durable';
import { PiHarness } from 'agents/harness/pi';
import { Lifecycle } from 'agents/lifecycle';
import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../env';
import { commandRunState, reconcileCommands } from '../tools/command-state';
import { environment } from '../tools/environment';
import { interruptCommands } from '../tools/interrupt';
import { toolRegistry } from '../tools/registry';
import { admitCancellation, executeCancellation } from './cancellation';
import { sessionModels } from './credentials';
import { events } from './events';
import { messageState } from './message-state';
import { messageReceipt, submitMessage } from './messages';
import { history, snapshotFromView } from './transcript';

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
          registry: toolRegistry({ env: this.env, storage: this.ctx.storage, harness: this.harness }),
          env: () => environment({ env: this.env, storage: this.ctx.storage, harness: this.harness }),
          onWake,
          settings: { followUpMode: 'one-at-a-time' },
        },
        context,
      ),
  });

  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  async initialize(raw: SessionCreation): Promise<Session> {
    const creation = SessionCreation.parse(raw);
    await this.lifecycle.start();
    const existing = await this.ctx.storage.get<unknown>('session');

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

    await this.ctx.storage.put('session', session);

    return this.getSession();
  }

  async submitMessage(raw: SubmitMessageRequest): Promise<Response> {
    await this.lifecycle.start();

    return this.ctx.blockConcurrencyWhile(async () =>
      submitMessage(
        { storage: this.ctx.storage, harness: this.harness },
        this.models,
        await this.sessionProjection(),
        raw,
      ),
    );
  }

  async cancelRun(raw: CancelRunRequest): Promise<Response> {
    await this.lifecycle.start();

    const admitted = await this.ctx.blockConcurrencyWhile(async () =>
      admitCancellation(this.ctx.storage, this.harness, await this.sessionProjection(), raw),
    );

    if (admitted instanceof Response) return admitted;

    return executeCancellation(this.ctx.storage, this.harness, admitted, (ids) =>
      interruptCommands({ env: this.env, storage: this.ctx.storage, harness: this.harness }, ids),
    );
  }

  async history(query: PageQuery): Promise<Response> {
    const result = await history(this.harness, await this.getSession(), query);

    return result instanceof Response ? result : Response.json(result);
  }

  async snapshot(): Promise<Response> {
    const session = await this.getSession();
    const watch = await (await (await this.harness.pi()).root(BG)).watch(BG);

    try {
      return Response.json(await snapshotFromView(session, watch.value));
    } finally {
      await watch.stop();
    }
  }

  async events(): Promise<Response> {
    await this.lifecycle.start();

    return events(this.harness, () => this.getSession());
  }

  async getReceipt(id: string): Promise<Response> {
    await this.lifecycle.start();

    return messageReceipt({ storage: this.ctx.storage, harness: this.harness }, id);
  }

  async getSession(): Promise<Session> {
    await this.lifecycle.start();
    await reconcileCommands({ env: this.env, storage: this.ctx.storage, harness: this.harness });

    return this.sessionProjection();
  }

  private async sessionProjection(): Promise<Session> {
    await this.lifecycle.start();
    const saved = Session.parse(await this.ctx.storage.get<unknown>('session'));
    const root = await (await this.harness.pi()).root(BG);
    const agent = await root.agent(BG);

    if (!agent.model || String(root.id) !== saved.runtime.conversationId) throw new Error('Missing Pi binding');

    const configured = this.models.getModel(agent.model.provider, agent.model.modelId);
    const available = configured !== undefined && (await this.models.checkAuth(agent.model.provider)) !== undefined;

    const native = await messageState({ storage: this.ctx.storage, harness: this.harness });
    const remote = await commandRunState({ env: this.env, storage: this.ctx.storage, harness: this.harness });

    return Session.parse({
      ...saved,
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
      run: remote ?? native.run,
    });
  }
}
