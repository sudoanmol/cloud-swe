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
import { SessionListPosition, WorkspaceRecord } from '@cloud-swe/protocol/storage';
import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';

import type { Env } from '../env';
import { approvalRoutes } from '../git/approval-routes';
import { apiError, fail, handleError } from '../http';
import { hasSession, indexSession, listSessions, readWorkspace } from './catalog-store';
import { admitCreation, admitReplacement, ensureWorkspace } from './create';
import { messageRoutes } from './message-routes';
import { readRoutes } from './read-routes';
import { WorkspaceLifecycle, type ResumeResult } from './workspace-lifecycle';

type Replacement = { ok: true; workspaceId: string } | { ok: false; reason: 'limit' | 'unavailable' };

/** Personal account's index, creation intents and workspace records; never another agent runtime. */
export class SessionCatalog extends DurableObject<Env> {
  readonly app = new Hono();
  readonly workspaces: WorkspaceLifecycle;
  // Concurrent messages for one deleted workspace share a single replacement.
  private readonly replacing = new Map<string, Promise<Replacement>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.workspaces = new WorkspaceLifecycle(ctx.storage, env);
    this.app.onError(handleError);
    this.app.notFound(() => apiError(404, 'not_found', 'Not found'));
    messageRoutes(this.app, env, ctx.storage);
    approvalRoutes(this.app, env, ctx.storage);
    readRoutes(this.app, env, ctx.storage);

    this.app.post('/v1/sessions', async (c) => {
      const input: unknown = await c.req.json().catch(() => null);
      const parsed = CreateSessionRequest.safeParse(input);

      if (!parsed.success) return apiError(400, 'invalid_request', 'Invalid session request');

      // Correct a full-looking cap against Boat first; the gate below only counts stored state.
      await this.workspaces.refreshIfFull();

      // Serialize only admission, so parallel creations provision their sandboxes concurrently.
      const admitted = await this.ctx.blockConcurrencyWhile(() =>
        admitCreation(this.ctx.storage, this.env, parsed.data),
      );

      if (admitted instanceof Response) return admitted;
      const { creation, replay } = admitted;
      await ensureWorkspace(this.ctx.storage, this.env, creation);
      await this.workspaces.scheduleSweep();
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

  private async ownedWorkspace(sessionId: string, workspaceId: string) {
    const workspace = await readWorkspace(this.ctx.storage, workspaceId);

    if (!workspace || workspace.sessionId !== sessionId || workspace.id !== workspaceId)
      throw new Error('Workspace binding mismatch');

    return workspace;
  }

  // Private RPC: callers cannot select a sandbox through a public tool argument.
  // Refuses a sandbox known to be stopped or deleted, so a tool says why instead of failing opaquely.
  async workspaceBinding(sessionId: string, workspaceId: string): Promise<WorkspaceRecord> {
    const { state, ...binding } = await this.ownedWorkspace(sessionId, workspaceId);

    if (state === 'deleted') throw new Error('The session workspace was deleted or its saved disk expired');

    if (state === 'stopped') throw new Error('The session workspace is stopped; send a message to resume it');

    return WorkspaceRecord.parse({
      id: binding.id,
      sessionId: binding.sessionId,
      provider: binding.provider,
      sandboxId: binding.sandboxId,
    });
  }

  /** The state clients see. `fresh` skips the short-lived cache. */
  async workspaceState(sessionId: string, workspaceId: string, fresh = false): Promise<Session['workspace']['state']> {
    return this.workspaces.state(await this.ownedWorkspace(sessionId, workspaceId), fresh);
  }

  async resumeWorkspace(sessionId: string, workspaceId: string): Promise<ResumeResult> {
    await this.ownedWorkspace(sessionId, workspaceId);

    return this.workspaces.resume(workspaceId);
  }

  /**
   * A new, empty sandbox for a session whose sandbox was deleted. Retried messages share one replacement, and it
   * counts against the cap like a creation.
   */
  replaceWorkspace(sessionId: string, oldWorkspaceId: string): Promise<Replacement> {
    const running = this.replacing.get(oldWorkspaceId);

    if (running) return running;
    const task = this.replace(sessionId, oldWorkspaceId).finally(() => this.replacing.delete(oldWorkspaceId));
    this.replacing.set(oldWorkspaceId, task);

    return task;
  }

  private async replace(sessionId: string, oldWorkspaceId: string): Promise<Replacement> {
    const old = await this.ownedWorkspace(sessionId, oldWorkspaceId);

    if (old.state !== 'deleted') throw new Error('Workspace is not deleted');
    await this.workspaces.refreshIfFull();

    const admitted = await this.ctx.blockConcurrencyWhile(() =>
      admitReplacement(this.ctx.storage, this.env, sessionId, oldWorkspaceId),
    );

    if (admitted instanceof Response) return { ok: false, reason: admitted.status === 409 ? 'limit' : 'unavailable' };

    try {
      const entry = await ensureWorkspace(this.ctx.storage, this.env, admitted);
      await this.workspaces.scheduleSweep();

      return { ok: true, workspaceId: entry.id };
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }

  async keepAlive(sessionId: string, workspaceId: string, mode: 'active' | 'finished') {
    await this.ownedWorkspace(sessionId, workspaceId);

    return this.workspaces.keepAlive(workspaceId, mode);
  }

  async alarm(): Promise<void> {
    await this.workspaces.sweep();
  }

  async fetch(request: Request): Promise<Response> {
    return this.app.fetch(request);
  }
}
