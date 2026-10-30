import type { CreateSessionRequest } from '@cloud-swe/protocol';
import { SessionCreation, WorkspaceEntry } from '@cloud-swe/protocol/storage';
import { Effect } from 'effect';

import type { Env } from '../env';
import { apiError, fail } from '../http';
import { recoverOrProvisionWorkspace, waitForWorkspace } from '../workspaces';
import { WORKSPACE_API_ERROR, WorkspaceError } from '../workspaces/errors';
import { workspaceSettings } from '../workspaces/settings';
import {
  adoptWorkspace,
  readCreation,
  readReplacement,
  readSessionCreation,
  readWorkspace,
  holdProvisioning,
  holdsProvisioning,
  releaseProvisioning,
  runningCount,
  writeCreation,
  writeReplacement,
} from './catalog-store';
import { sandboxLimitError } from './workspace-lifecycle';

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
  const stored = await readCreation(storage, request.operationId);

  if (stored) {
    const creation = stored;

    if (JSON.stringify(creation.request) !== JSON.stringify(request)) {
      return apiError('operation_conflict');
    }

    return { creation, replay: true };
  }

  if (!env.WORKSPACE_ENVIRONMENTS.split(',').includes(request.environment)) {
    return apiError('unknown_environment');
  }

  if (request.model.provider !== env.MODEL_PROVIDER || request.model.id !== env.MODEL_ID) {
    return apiError('unknown_model');
  }

  // The only product limit. Stored state only; the route corrected it against Boat first if it looked full.
  if ((await runningCount(storage)) >= workspaceSettings(env).maxSandboxes) {
    return sandboxLimitError(env);
  }

  const creation = SessionCreation.parse({
    request,
    sessionId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  });

  // Persist the intent before any side effect; retries resume from whatever was last committed.
  await writeCreation(storage, creation);

  return { creation, replay: false };
}

/**
 * Records the intent for a new sandbox that replaces a deleted one, or returns the one already recorded. The intent is
 * keyed by the deleted workspace, so retried messages share one replacement. It is checked against the cap like a creation.
 */
export async function admitReplacement(
  storage: DurableObjectStorage,
  env: Env,
  sessionId: string,
  oldWorkspaceId: string,
): Promise<SessionCreation | Response> {
  const stored = await readReplacement(storage, oldWorkspaceId);

  if (stored) return stored;

  if ((await runningCount(storage)) >= workspaceSettings(env).maxSandboxes) return sandboxLimitError(env);
  const original = await readSessionCreation(storage, sessionId);

  if (!original) return apiError('internal_error');

  const creation = SessionCreation.parse({
    // A fresh UUID is Boat's idempotency key for this replacement, stable across retries.
    request: { ...original.request, operationId: crypto.randomUUID() },
    sessionId,
    workspaceId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  });

  await writeReplacement(storage, oldWorkspaceId, creation);

  return creation;
}

/** Ensures the session's own sandbox exists and is running. Safe to repeat for the same creation. */
export async function ensureWorkspace(
  storage: DurableObjectStorage,
  env: Env,
  creation: SessionCreation,
): Promise<WorkspaceEntry> {
  const stored = await readWorkspace(storage, creation.workspaceId);
  let workspace: WorkspaceEntry;

  if (!stored) {
    // A retry after a definite refusal has no marker: it holds no slot, so it must win one again like a new creation.
    if (!(await holdsProvisioning(storage, creation.workspaceId))) {
      if ((await runningCount(storage)) >= workspaceSettings(env).maxSandboxes) {
        fail('sandbox_limit_reached', { limit: workspaceSettings(env).maxSandboxes });
      }

      await holdProvisioning(storage, creation);
    }

    const sandboxId = await Effect.runPromise(
      recoverOrProvisionWorkspace(env, creation).pipe(Effect.orElseSucceed((error) => error)),
    );

    if (sandboxId instanceof WorkspaceError) {
      // Only a definite refusal proves nothing was created. Any other failure may have made a sandbox, so its
      // marker keeps holding a slot until Boat's idempotency window closes.
      if (sandboxId.reason === 'refused' || sandboxId.reason === 'configuration') {
        await releaseProvisioning(storage, creation.workspaceId);
      }

      fail(WORKSPACE_API_ERROR[sandboxId.reason]);
    }

    workspace = WorkspaceEntry.parse({
      id: creation.workspaceId,
      sessionId: creation.sessionId,
      provider: env.WORKSPACE_BACKEND,
      sandboxId,
      state: 'running',
      lastActiveAt: new Date().toISOString(),
    });

    await adoptWorkspace(storage, workspace);
  } else {
    workspace = stored;
  }

  const state = await Effect.runPromise(
    waitForWorkspace(env, workspace.sandboxId).pipe(Effect.orElseSucceed((error) => error)),
  );

  if (state instanceof WorkspaceError) fail(WORKSPACE_API_ERROR[state.reason]);

  // A retried creation may find its sandbox stopped since; that is a session state, not a failure.
  if (state !== 'running' && !(stored && (state === 'stopped' || state === 'deleted'))) fail('sandbox_not_ready');

  return workspace;
}
