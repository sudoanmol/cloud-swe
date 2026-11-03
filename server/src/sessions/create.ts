/**
 * Path: server/src/sessions/create.ts
 * Used by: server/src/sessions/{catalog,routes}.ts.
 * Purpose: Admits a session creation or sandbox replacement against the cap, persisting its intent before any side effect, and ensures the sandbox exists and runs. Safe to repeat.
 */

import type { CreateSessionRequest } from '@cloud-swe/protocol';
import { SessionCreation, WorkspaceEntry } from '@cloud-swe/protocol/storage';
import { Effect } from 'effect';

import type { Env } from '../env.ts';
import { apiError, fail } from '../errors.ts';
import { WORKSPACE_API_ERROR, WorkspaceError } from '../workspaces/errors.ts';
import { recoverOrProvisionWorkspace, waitForWorkspace } from '../workspaces/index.ts';
import { workspaceSettings } from '../workspaces/settings.ts';
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
} from './catalog-store.ts';
import { sandboxLimitError } from './workspace-lifecycle.ts';

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

  // The only product limit. Stored state only; the route corrected it against the provider first if it looked full.
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
    // A fresh UUID is the replacement's operation ID, stable across retries.
    request: { ...original.request, operationId: crypto.randomUUID() },
    sessionId,
    workspaceId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  });

  await writeReplacement(storage, oldWorkspaceId, creation);

  return creation;
}

// E2B has no idempotency key on create, and its list takes up to about half a second to show a new sandbox (measured).
// So retries of one creation that arrive together must share one lookup and create, kept until the result is stored.
const provisioning = new Map<string, Promise<{ workspace: WorkspaceEntry; existed: boolean }>>();

function provisionOnce(storage: DurableObjectStorage, env: Env, creation: SessionCreation) {
  const running = provisioning.get(creation.workspaceId);

  if (running) return running;
  const task = provision(storage, env, creation).finally(() => provisioning.delete(creation.workspaceId));
  provisioning.set(creation.workspaceId, task);

  return task;
}

async function provision(storage: DurableObjectStorage, env: Env, creation: SessionCreation) {
  const stored = await readWorkspace(storage, creation.workspaceId);

  if (stored) return { workspace: stored, existed: true };

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
    // marker keeps holding a slot until the retry window closes.
    if (sandboxId.reason === 'refused' || sandboxId.reason === 'configuration') {
      await releaseProvisioning(storage, creation.workspaceId);
    }

    fail(WORKSPACE_API_ERROR[sandboxId.reason]);
  }

  const workspace = WorkspaceEntry.parse({
    id: creation.workspaceId,
    sessionId: creation.sessionId,
    provider: env.WORKSPACE_BACKEND,
    sandboxId,
    state: 'running',
    lastActiveAt: new Date().toISOString(),
  });

  await adoptWorkspace(storage, workspace);

  return { workspace, existed: false };
}

/** Ensures the session's own sandbox exists and is running. Safe to repeat for the same creation. */
export async function ensureWorkspace(
  storage: DurableObjectStorage,
  env: Env,
  creation: SessionCreation,
): Promise<WorkspaceEntry> {
  const { workspace, existed } = await provisionOnce(storage, env, creation);

  const state = await Effect.runPromise(
    waitForWorkspace(env, workspace.sandboxId).pipe(Effect.orElseSucceed((error) => error)),
  );

  if (state instanceof WorkspaceError) fail(WORKSPACE_API_ERROR[state.reason]);

  // A retried creation may find its sandbox stopped since; that is a session state, not a failure.
  if (state !== 'running' && !(existed && (state === 'stopped' || state === 'deleted'))) fail('sandbox_not_ready');

  return workspace;
}
