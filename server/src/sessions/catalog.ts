/**
 * Path: server/src/sessions/catalog.ts
 * Used by: server/src/{env,index}.ts.
 * Purpose: The Catalog DO: the account-wide session and workspace index, and the private RPC a Thread uses to reach its sandbox.
 */

import type { Session } from '@cloud-swe/protocol';
import type { WorkspaceRecord } from '@cloud-swe/protocol/storage';
import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';

import type { Env } from '../env.ts';
import { apiError, handleError } from '../errors.ts';
import { readWorkspace } from './catalog-store.ts';
import { sessionRoutes } from './routes.ts';
import { WorkspaceLifecycle } from './workspace-lifecycle.ts';

/** Personal account's index, creation intents and workspace records; never another agent runtime. */
export class Catalog extends DurableObject<Env> {
  private readonly app = new Hono();
  private readonly workspaces: WorkspaceLifecycle;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.workspaces = new WorkspaceLifecycle(ctx, env);
    this.app.onError(handleError);
    this.app.notFound(() => apiError('not_found'));
    sessionRoutes(this.app, ctx.storage, env, this.workspaces);
  }

  private async ownedWorkspace(sessionId: string, workspaceId: string) {
    const workspace = await readWorkspace(this.ctx.storage, workspaceId);

    if (workspace?.sessionId !== sessionId) throw new Error('Workspace binding mismatch');

    return workspace;
  }

  // Private RPC: callers cannot select a sandbox through a public tool argument.
  // Refuses a sandbox known to be stopped or deleted, so a tool says why instead of failing opaquely.
  async workspaceBinding(sessionId: string, workspaceId: string): Promise<WorkspaceRecord> {
    const workspace = await this.ownedWorkspace(sessionId, workspaceId);

    if (workspace.state === 'deleted') throw new Error('The session workspace was deleted or its saved disk expired');

    if (workspace.state === 'stopped') throw new Error('The session workspace is stopped; send a message to resume it');

    return {
      id: workspace.id,
      sessionId: workspace.sessionId,
      provider: workspace.provider,
      sandboxId: workspace.sandboxId,
    };
  }

  /** The state clients see. `fresh` skips the short-lived cache. */
  async workspaceState(sessionId: string, workspaceId: string, fresh = false): Promise<Session['workspace']['state']> {
    return this.workspaces.state(await this.ownedWorkspace(sessionId, workspaceId), fresh);
  }

  async resumeWorkspace(sessionId: string, workspaceId: string) {
    return this.workspaces.resume(await this.ownedWorkspace(sessionId, workspaceId));
  }

  async replaceWorkspace(sessionId: string, oldWorkspaceId: string) {
    return this.workspaces.replace(await this.ownedWorkspace(sessionId, oldWorkspaceId));
  }

  async keepAlive(sessionId: string, workspaceId: string, mode: 'active' | 'finished') {
    return this.workspaces.keepAlive(await this.ownedWorkspace(sessionId, workspaceId), mode);
  }

  override async alarm(): Promise<void> {
    await this.workspaces.sweep();
  }

  override async fetch(request: Request): Promise<Response> {
    return this.app.fetch(request);
  }
}
