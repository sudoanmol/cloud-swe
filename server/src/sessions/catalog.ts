/**
 * Path: server/src/sessions/catalog.ts
 * Used by: server/src/sessions/index.ts (SessionCatalog DO, reached from server/src/index.ts).
 * Purpose: The account-wide session and workspace index. Creates and lists sessions, and forwards per-session routes to their Thread.
 */
import type { Session } from '@cloud-swe/protocol';
import { WorkspaceRecord } from '@cloud-swe/protocol/storage';
import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';

import type { Env } from '../env.ts';
import { apiError, handleError } from '../errors.ts';
import { readWorkspace } from './catalog-store.ts';
import { admitReplacement, ensureWorkspace } from './create.ts';
import { sessionRoutes } from './routes.ts';
import { type ResumeResult, WorkspaceLifecycle } from './workspace-lifecycle.ts';

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
    this.app.notFound(() => apiError('not_found'));
    sessionRoutes(this.app, ctx, env, this.workspaces);
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
