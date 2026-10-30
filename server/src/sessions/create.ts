import type { CreateSessionRequest } from '@cloud-swe/protocol';
import { SessionCreation, WorkspaceRecord } from '@cloud-swe/protocol/storage';
import { Effect } from 'effect';

import type { Env } from '../env';
import { apiError, fail } from '../http';
import { recoverOrProvisionWorkspace, waitForWorkspace } from '../workspaces';
import { WorkspaceError } from '../workspaces/errors';

type Admission = { creation: SessionCreation; replay: boolean };

/**
 * Records the creation intent, or returns the one already recorded for this operation ID.
 * Runs inside blockConcurrencyWhile, so it returns error responses instead of throwing (a throw resets the DO).
 */
export async function admitCreation(
  storage: DurableObjectStorage,
  env: Env,
  request: CreateSessionRequest,
): Promise<Admission | Response> {
  const key = `operation:${request.operationId}`;
  const stored = await storage.get<unknown>(key);

  if (stored !== undefined) {
    const creation = SessionCreation.parse(stored);

    if (JSON.stringify(creation.request) !== JSON.stringify(request)) {
      return apiError(409, 'operation_conflict', 'Operation ID already used for a different request');
    }

    return { creation, replay: true };
  }

  if (!env.WORKSPACE_ENVIRONMENTS.split(',').includes(request.environment)) {
    return apiError(400, 'invalid_request', 'Environment is not configured');
  }

  if (request.model.provider !== env.MODEL_PROVIDER || request.model.id !== env.MODEL_ID) {
    return apiError(400, 'invalid_request', 'Model is not configured');
  }

  const creation = SessionCreation.parse({
    request,
    sessionId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  });

  // Persist the intent before any side effect; retries resume from whatever was last committed.
  await storage.put(key, creation);

  return { creation, replay: false };
}

/** Ensures the session's own sandbox exists and is running. Safe to repeat for the same creation. */
export async function ensureWorkspace(
  storage: DurableObjectStorage,
  env: Env,
  creation: SessionCreation,
): Promise<WorkspaceRecord> {
  const key = `workspace:${creation.workspaceId}`;
  const stored = await storage.get<unknown>(key);
  let workspace: WorkspaceRecord;

  if (stored === undefined) {
    const sandboxId = await Effect.runPromise(
      recoverOrProvisionWorkspace(env, creation).pipe(Effect.orElseSucceed((error) => error)),
    );

    if (sandboxId instanceof WorkspaceError) {
      fail(
        503,
        'unavailable',
        sandboxId.reason === 'uncertain' ? 'Workspace provisioning outcome is unknown' : 'Workspace unavailable',
      );
    }

    workspace = WorkspaceRecord.parse({
      id: creation.workspaceId,
      sessionId: creation.sessionId,
      provider: env.WORKSPACE_BACKEND,
      sandboxId,
    });

    await storage.put(key, workspace);
  } else {
    workspace = WorkspaceRecord.parse(stored);
  }

  const state = await Effect.runPromise(
    waitForWorkspace(env, workspace.sandboxId).pipe(Effect.orElseSucceed(() => null)),
  );

  if (state === null) fail(503, 'unavailable', 'Workspace unavailable');

  if (state !== 'running') fail(503, 'unavailable', 'Workspace is not running');

  return workspace;
}
