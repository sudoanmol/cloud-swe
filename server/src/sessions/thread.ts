import { Session } from '@cloud-swe/protocol';
import { SessionCreation } from '@cloud-swe/protocol/storage';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { PiHarness } from 'agents/harness/pi';
import { Lifecycle } from 'agents/lifecycle';
import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../env';

/** One application session owns exactly one native Pi root conversation. */
export class Thread extends DurableObject<Env> {
  readonly harness = new PiHarness({
    harness: ({ storage, context, onWake }) =>
      Harness.open(
        storage,
        {
          models: createModels(),
          registry: createRegistry(),
          onWake,
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

  async getSession(): Promise<Session> {
    await this.lifecycle.start();
    const saved = Session.parse(await this.ctx.storage.get<unknown>('session'));
    const root = await (await this.harness.pi()).root(BG);
    const agent = await root.agent(BG);

    if (!agent.model || String(root.id) !== saved.runtime.conversationId) throw new Error('Missing Pi binding');

    return Session.parse({ ...saved, model: { provider: agent.model.provider, id: agent.model.modelId } });
  }
}
