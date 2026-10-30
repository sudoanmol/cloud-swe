import type { CreateSessionRequest } from '@cloud-swe/protocol';
import { SessionCreation, WorkspaceRecord } from '@cloud-swe/protocol/storage';

import type { Env } from '../env';
import { apiError, fail } from '../http';
import { provisionWorkspace, waitForWorkspace } from '../workspaces';

type Admission = { creation: SessionCreation; replay: boolean };

// Boat keeps idempotency keys for 24 h. Past that, a retried create could bill a second sandbox.
const PROVISION_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;

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
    if (Date.now() - Date.parse(creation.createdAt) > PROVISION_RETRY_WINDOW_MS) {
      fail(503, 'unavailable', 'Workspace provisioning outcome is unknown');
    }

    let sandboxId: string;

    try {
      sandboxId = await provisionWorkspace(env, creation);
    } catch {
      fail(503, 'unavailable', 'Workspace unavailable');
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

  let state: Awaited<ReturnType<typeof waitForWorkspace>>;

  try {
    state = await waitForWorkspace(env, workspace.sandboxId);
  } catch {
    fail(503, 'unavailable', 'Workspace unavailable');
  }

  if (state !== 'running') fail(503, 'unavailable', 'Workspace is not running');

  return workspace;
}
