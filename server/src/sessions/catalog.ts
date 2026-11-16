/**
 * Path: server/src/sessions/catalog.ts
 * Used by: server/src/{env,index}.ts.
 * Purpose: The Catalog DO: the account-wide session list and workspace index, session creation, and the private RPC a Thread uses to reach its sandbox and update its list row.
 */

import { type CreateSessionRequest, CreateSessionResponse, type Session, sessionSummary } from '@cloud-swe/protocol';
import { StoredSessionSummary, type WorkspaceRecord } from '@cloud-swe/protocol/storage';
import { DurableObject } from 'cloudflare:workers';

import { credentialsStub, type Env, threadStub } from '../env.ts';
import { apiError, handleError } from '../errors.ts';
import {
  fillSummaries,
  indexSession,
  listSummaries,
  readCreation,
  readWorkspace,
  writeSummary,
} from './catalog-store.ts';
import { admitCreation } from './create.ts';
import { storedSummary } from './summary.ts';
import { WorkspaceLifecycle } from './workspace-lifecycle.ts';

/** Personal account's index, creation intents and workspace records; never another agent runtime. */
export class Catalog extends DurableObject<Env> {
  private readonly workspaces: WorkspaceLifecycle;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.workspaces = new WorkspaceLifecycle(ctx, env);
    void ctx.blockConcurrencyWhile(() => fillSummaries(ctx.storage));
  }

  /** Creates the session, or returns the one this operation ID already created. The route has checked the request. */
  async createSession(request: CreateSessionRequest): Promise<Response> {
    try {
      const storage = this.ctx.storage;
      const { environment, operationId } = request;

      // Checked only before admission: a retry or a replacement sandbox never depends on the environment still existing.
      if (
        environment &&
        !(await readCreation(storage, operationId)) &&
        !(await credentialsStub(this.env).hasEnvironment(environment))
      ) {
        return apiError('unknown_environment');
      }

      const admitted = await this.workspaces.admit(() => admitCreation(storage, this.env, request));

      if (admitted instanceof Response) return admitted;
      const { creation, replay } = admitted;
      await this.workspaces.ensure(creation);
      const session = await threadStub(this.env, creation.sessionId).initialize(creation);

      await indexSession(storage, creation, storedSummary(sessionSummary(session, null)));

      return Response.json(CreateSessionResponse.parse({ operationId, session }), { status: replay ? 200 : 201 });
    } catch (error) {
      if (error instanceof Error) return handleError(error);
      throw error;
    }
  }

  /** A page of the list, read from list rows alone: no session is asked. `before` is a previous page's last key. */
  async listSessions(before: string | undefined, limit: number) {
    return listSummaries(this.ctx.storage, before, limit);
  }

  /** Private RPC: a session's list row, written by the session whenever its summary changes. */
  async writeSummary(row: StoredSessionSummary): Promise<void> {
    await writeSummary(this.ctx.storage, StoredSessionSummary.parse(row));
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
}
