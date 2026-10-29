import {
  CreateSessionRequest,
  CreateSessionResponse,
  ListSessionsResponse,
  PageQuery,
  Session,
  SessionParams,
} from '@cloud-swe/protocol';
import { SessionCreation, SessionListPosition } from '@cloud-swe/protocol/storage';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { PiHarness } from 'agents/harness/pi';
import { Lifecycle } from 'agents/lifecycle';
import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';

import type { Env } from './env';
import { apiError, fail, handleError } from './http';
import { inspectWorkspace } from './workspace';

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
      workspace: { id: creation.request.workspaceId, provider: this.env.WORKSPACE_BACKEND, state: 'running' },
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

/** Personal account's index/creation intents, never another agent runtime. */
export class SessionCatalog extends DurableObject<Env> {
  readonly app = new Hono();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.app.onError(handleError);
    this.app.notFound(() => apiError(404, 'not_found', 'Not found'));
    this.app.post('/v1/sessions', async (c) => {
      const input: unknown = await c.req.json().catch(() => null);
      const parsed = CreateSessionRequest.safeParse(input);

      if (!parsed.success) return apiError(400, 'invalid_request', 'Invalid session request');

      // Personal-first: serialize creations, including awaits, to deduplicate concurrent retries.
      return this.ctx.blockConcurrencyWhile(async () => {
        const request = parsed.data;
        const key = `operation:${request.operationId}`;
        const stored = await this.ctx.storage.get<unknown>(key);
        let creation: SessionCreation;
        const replay = stored !== undefined;

        if (replay) {
          creation = SessionCreation.parse(stored);

          if (JSON.stringify(creation.request) !== JSON.stringify(request)) {
            return apiError(409, 'operation_conflict', 'Operation ID already used for a different request');
          }
        } else {
          if (request.workspaceId !== this.env.WORKSPACE_ID) return apiError(404, 'not_found', 'Workspace not found');

          if (request.model.provider !== this.env.MODEL_PROVIDER || request.model.id !== this.env.MODEL_ID) {
            return apiError(400, 'invalid_request', 'Model is not configured');
          }

          let state: Session['workspace']['state'];

          try {
            state = await inspectWorkspace(this.env);
          } catch {
            return apiError(503, 'unavailable', 'Workspace unavailable');
          }

          if (state !== 'running') return apiError(503, 'unavailable', 'Workspace is not running');
          creation = SessionCreation.parse({
            request,
            sessionId: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
          });
          // Persist the application ID before opening Pi; recovery targets the same DO/root.
          await this.ctx.storage.put(key, creation);
        }

        const thread = this.env.THREADS.get(this.env.THREADS.idFromName(creation.sessionId));
        const session = await thread.initialize(creation);
        await this.ctx.storage.put({
          [`id:${session.id}`]: creation,
          [`session:${session.createdAt}:${session.id}`]: creation,
        });

        return c.json(CreateSessionResponse.parse({ operationId: request.operationId, session }), replay ? 200 : 201);
      });
    });

    this.app.get('/v1/sessions', async (c) => {
      const parsed = PageQuery.safeParse(c.req.query());

      if (!parsed.success) return apiError(400, 'invalid_request', 'Invalid pagination');
      let startAfter: string | undefined;

      if (parsed.data.cursor) {
        try {
          startAfter = SessionListPosition.parse(atob(parsed.data.cursor));
        } catch {
          return apiError(400, 'invalid_request', 'Invalid session cursor');
        }
      }

      const rows = await this.ctx.storage.list<unknown>({
        prefix: 'session:',
        startAfter,
        limit: parsed.data.limit + 1,
      });

      const page = [...rows.entries()].slice(0, parsed.data.limit);

      const sessions = await Promise.all(
        page.map(async ([, raw]) => {
          const { sessionId } = SessionCreation.parse(raw);

          return this.env.THREADS.get(this.env.THREADS.idFromName(sessionId)).getSession();
        }),
      );

      const last = page.at(-1);

      return c.json(
        ListSessionsResponse.parse({
          sessions,
          nextCursor: rows.size > parsed.data.limit && last ? btoa(last[0]) : null,
        }),
      );
    });

    this.app.get('/v1/sessions/:sessionId', async (c) => {
      const parsed = SessionParams.safeParse(c.req.param());

      if (!parsed.success) return apiError(400, 'invalid_request', 'Invalid session ID');
      const { sessionId: id } = parsed.data;

      if ((await this.ctx.storage.get(`id:${id}`)) === undefined) fail(404, 'not_found', 'Session not found');
      const session = await this.env.THREADS.get(this.env.THREADS.idFromName(id)).getSession();

      return c.json(Session.parse(session));
    });
  }

  async fetch(request: Request): Promise<Response> {
    return this.app.fetch(request);
  }
}
