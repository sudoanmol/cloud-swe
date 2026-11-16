/**
 * Path: server/src/sessions/create.ts
 * Used by: server/src/sessions/{routes,workspace-lifecycle}.ts.
 * Purpose: The MAX_SANDBOXES cap, and the admission of a session creation or sandbox replacement against it, persisting its intent before any side effect. Also provisions the admitted sandbox. Safe to repeat.
 */

import { type CreateSessionRequest, TemplateName } from '@cloud-swe/protocol';
import { SessionCreation, WorkspaceEntry } from '@cloud-swe/protocol/storage';
import type { z } from 'zod';

import type { Env } from '../env.ts';
import { apiError, fail } from '../errors.ts';
import { WORKSPACE_API_ERROR, WorkspaceError } from '../workspaces/errors.ts';
import { recoverOrProvisionWorkspace, settle, waitForWorkspace } from '../workspaces/index.ts';
import { sandboxLimitError, sandboxLimitParams, workspaceSettings } from '../workspaces/settings.ts';
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
import { sameRequest, singleFlight } from './idempotency.ts';

/** Whether MAX_SANDBOXES already run, by stored state only, so it costs no provider call. */
export async function atCapacity(
  storage: Pick<DurableObjectStorage, 'list'>,
  env: Pick<Env, 'MAX_SANDBOXES'>,
  except?: string,
): Promise<boolean> {
  return (await runningCount(storage, except)) >= workspaceSettings(env).maxSandboxes;
}

/** A replacement that is not admitted; the Thread turns it into the message's error. */
export type ReplacementRefusal = { ok: false; reason: 'limit' | 'unavailable' };

const newCreation = (
  intent: Pick<z.input<typeof SessionCreation>, 'request' | 'template' | 'model'>,
  sessionId: string,
) =>
  SessionCreation.parse({
    ...intent,
    sessionId,
    workspaceId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  });

/**
 * Records the creation intent, or returns the one already recorded for this operation ID.
 * Runs inside blockConcurrencyWhile, so it returns error responses instead of throwing (a throw resets the DO).
 */
export async function admitCreation(
  storage: DurableObjectStorage,
  env: Env,
  request: CreateSessionRequest,
): Promise<{ creation: SessionCreation; replay: boolean } | Response> {
  const stored = await readCreation(storage, request.operationId);

  // A retry is the same body as first sent: leaving out a default the first request named is a different request.
  if (stored)
    return sameRequest(stored.request, SessionCreation.shape.request.parse(request))
      ? { creation: stored, replay: true }
      : apiError('operation_conflict');

  const templates = env.WORKSPACE_TEMPLATES.split(',');
  const template = TemplateName.safeParse(request.template ?? templates[0]);

  if (!template.success || !templates.includes(template.data)) return apiError('unknown_template');
  const model = request.model ?? { provider: 'anthropic', id: env.MODEL_ID };

  if (model.provider !== 'anthropic' || model.id !== env.MODEL_ID) return apiError('unknown_model');

  // The only product limit. Its caller corrected the stored count against the provider first if it looked full.
  if (await atCapacity(storage, env)) return sandboxLimitError(env);

  const creation = newCreation({ request, template: template.data, model }, crypto.randomUUID());
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
): Promise<{ ok: true; creation: SessionCreation } | ReplacementRefusal> {
  const stored = await readReplacement(storage, oldWorkspaceId);

  if (stored) return { ok: true, creation: stored };

  if (await atCapacity(storage, env)) return { ok: false, reason: 'limit' };
  const original = await readSessionCreation(storage, sessionId);

  if (!original) return { ok: false, reason: 'unavailable' };

  // A fresh UUID is the replacement's operation ID, stable across retries.
  const creation = newCreation(
    { ...original, request: { ...original.request, operationId: crypto.randomUUID() } },
    sessionId,
  );

  await writeReplacement(storage, oldWorkspaceId, creation);

  return { ok: true, creation };
}

// E2B has no idempotency key on create, and its list takes up to about half a second to show a new sandbox (measured).
// So retries of one creation that arrive together must share one lookup and create, kept until the result is stored.
const provisioning = singleFlight<{ workspace: WorkspaceEntry; existed: boolean }>();

async function provision(storage: DurableObjectStorage, env: Env, creation: SessionCreation) {
  const stored = await readWorkspace(storage, creation.workspaceId);

  if (stored) return { workspace: stored, existed: true };

  // A retry after a definite refusal has no marker: it holds no slot, so it must win one again like a new creation.
  if (!(await holdsProvisioning(storage, creation.workspaceId))) {
    if (await atCapacity(storage, env)) fail('sandbox_limit_reached', sandboxLimitParams(env));

    await holdProvisioning(storage, creation.workspaceId);
  }

  const sandboxId = await settle(recoverOrProvisionWorkspace(env, creation));

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
  const { workspace, existed } = await provisioning.run(creation.workspaceId, () => provision(storage, env, creation));

  const state = await settle(waitForWorkspace(env, workspace.sandboxId));

  if (state instanceof WorkspaceError) fail(WORKSPACE_API_ERROR[state.reason]);

  // A retried creation may find its sandbox stopped since; that is a session state, not a failure.
  if (state !== 'running' && !(existed && (state === 'stopped' || state === 'deleted'))) fail('sandbox_not_ready');

  return workspace;
}
