/**
 * Path: server/src/sessions/catalog.ts
 * Used by: server/src/sessions/index.ts (SessionCatalog DO, reached from server/src/index.ts).
 * Purpose: The account-wide session and workspace index. Creates and lists sessions, and forwards per-session routes to their Thread.
 */
import {
  CreateSessionRequest,
  CreateSessionResponse,
  ListSessionsResponse,
  PageQuery,
  Session,
  SessionParams,
} from '@cloud-swe/protocol';
import { SessionListPosition, type WorkspaceRecord } from '@cloud-swe/protocol/storage';
import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';

import type { Env } from '../env';
import { apiError, fail, handleError } from '../http';
import { hasSession, indexSession, listSessions, readWorkspace } from './catalog-store';
import { admitCreation, ensureWorkspace } from './create';
import { messageRoutes } from './message-routes';
import { readRoutes } from './read-routes';

/** Personal account's index, creation intents and workspace records; never another agent runtime. */
export class SessionCatalog extends DurableObject<Env> {
  readonly app = new Hono();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.app.onError(handleError);
    this.app.notFound(() => apiError(404, 'not_found', 'Not found'));
    messageRoutes(this.app, env, ctx.storage);
    readRoutes(this.app, env, ctx.storage);

    this.app.post('/v1/sessions', async (c) => {
      const input: unknown = await c.req.json().catch(() => null);
      const parsed = CreateSessionRequest.safeParse(input);

      if (!parsed.success) return apiError(400, 'invalid_request', 'Invalid session request');

      // Serialize only admission, so parallel creations provision their sandboxes concurrently.
      const admitted = await this.ctx.blockConcurrencyWhile(() =>
        admitCreation(this.ctx.storage, this.env, parsed.data),
      );

      if (admitted instanceof Response) return admitted;
      const { creation, replay } = admitted;
      await ensureWorkspace(this.ctx.storage, this.env, creation);
      const thread = this.env.THREADS.get(this.env.THREADS.idFromName(creation.sessionId));
      const session = await thread.initialize(creation);

      await indexSession(this.ctx.storage, creation, session.createdAt);

      return c.json(
        CreateSessionResponse.parse({ operationId: creation.request.operationId, session }),
        replay ? 200 : 201,
      );
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

      const { page, hasMore } = await listSessions(this.ctx.storage, startAfter, parsed.data.limit);

      // One broken Thread must not hide the rest; name it so the client knows the page is incomplete.
      const ids = page.map(({ creation }) => creation.sessionId);

      const reads = await Promise.allSettled(
        ids.map((sessionId) => this.env.THREADS.get(this.env.THREADS.idFromName(sessionId)).getSession()),
      );

      const sessions = reads.flatMap((read) => (read.status === 'fulfilled' ? [read.value] : []));
      const unavailable = ids.filter((_, index) => reads[index]?.status === 'rejected');

      const last = page.at(-1);

      return c.json(
        ListSessionsResponse.parse({
          sessions,
          unavailable,
          nextCursor: hasMore && last ? btoa(last.key) : null,
        }),
      );
    });

    this.app.get('/v1/sessions/:sessionId', async (c) => {
      const parsed = SessionParams.safeParse(c.req.param());

      if (!parsed.success) return apiError(400, 'invalid_request', 'Invalid session ID');
      const { sessionId: id } = parsed.data;

      if (!(await hasSession(this.ctx.storage, id))) fail(404, 'not_found', 'Session not found');
      const session = await this.env.THREADS.get(this.env.THREADS.idFromName(id)).getSession();

      return c.json(Session.parse(session));
    });
  }

  // Private RPC: callers cannot select a sandbox through a public tool argument.
  async workspaceBinding(sessionId: string, workspaceId: string): Promise<WorkspaceRecord> {
    const workspace = await readWorkspace(this.ctx.storage, workspaceId);

    if (!workspace || workspace.sessionId !== sessionId || workspace.id !== workspaceId)
      throw new Error('Workspace binding mismatch');

    return workspace;
  }

  async fetch(request: Request): Promise<Response> {
    return this.app.fetch(request);
  }
}
