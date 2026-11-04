/**
 * Path: server/src/workspaces/e2b.ts
 * Used by: server/src/sandbox/remote.ts, server/src/workspaces/index.ts.
 * Purpose: The E2B backend: sandbox create, recover, renew, resume, inspect and delete. Pausing keeps files and running processes.
 */

import type { Session } from '@cloud-swe/protocol';
import type { SessionCreation } from '@cloud-swe/protocol/storage';
import { AuthenticationError, NotFoundError, Sandbox, SandboxError } from 'e2b';
import { Effect } from 'effect';

import type { Env } from '../env.ts';
import { isRefusal, workspaceError, WorkspaceError } from './errors.ts';
import { IDLE_TTL_SECONDS } from './settings.ts';

type E2BEnv = Pick<Env, 'E2B_API_KEY'>;

// E2B has no idempotency key on create, so a lost create is found again by this metadata.
const WORKSPACE_METADATA = 'cloudSweWorkspace';

function apiKey(env: E2BEnv): string {
  if (!env.E2B_API_KEY) throw new WorkspaceError({ reason: 'configuration' });

  return env.E2B_API_KEY;
}

/** The session's template names the E2B template. A sandbox pauses itself at its deadline instead of being lost. */
export function createE2BSandbox(env: E2BEnv, creation: SessionCreation): Effect.Effect<string, WorkspaceError> {
  return Effect.tryPromise((signal) =>
    Sandbox.create(creation.request.template, {
      apiKey: apiKey(env),
      signal,
      timeoutMs: IDLE_TTL_SECONDS * 1000,
      metadata: { [WORKSPACE_METADATA]: creation.workspaceId },
      lifecycle: { onTimeout: 'pause', autoResume: false },
    }),
  ).pipe(
    Effect.timeout('30 seconds'),
    Effect.mapError((failure) => {
      const { cause } = failure;

      // A refusal means no sandbox exists, so the caller may release its slot.
      return cause instanceof AuthenticationError ||
        (cause instanceof SandboxError && cause.statusCode !== undefined && isRefusal(cause.statusCode))
        ? new WorkspaceError({ reason: 'refused' })
        : workspaceError(failure);
    }),
    Effect.map((sandbox) => sandbox.sandboxId),
  );
}

export async function findE2BSandbox(
  env: E2BEnv,
  creation: SessionCreation,
  signal: AbortSignal,
): Promise<string | null> {
  const pages = Sandbox.list({
    apiKey: apiKey(env),
    limit: 2,
    query: { metadata: { [WORKSPACE_METADATA]: creation.workspaceId } },
  });

  const matches = await pages.nextItems({ signal });

  // Never guess which sandbox belongs to an intent, or treat a truncated result as absence.
  if (pages.hasNext || matches.length > 1) throw new WorkspaceError({ reason: 'uncertain' });

  return matches[0]?.sandboxId ?? null;
}

/** Connecting resumes a paused sandbox and only ever raises its deadline, to at least five minutes by default. */
export const connectE2BSandbox = (env: E2BEnv, sandboxId: string, signal: AbortSignal, timeoutMs?: number) =>
  Sandbox.connect(sandboxId, { apiKey: apiKey(env), signal, timeoutMs });

/** Sets the deadline to now + ttlSeconds, lower or higher. Fails on a paused sandbox, as if it were missing. */
export async function renewE2BSandbox(env: E2BEnv, sandboxId: string, ttlSeconds: number, signal: AbortSignal) {
  await Sandbox.setTimeout(sandboxId, ttlSeconds * 1000, { apiKey: apiKey(env), signal });
}

/** Also what an active run renews with, because E2B pauses a sandbox at its plan's limit even mid-run. */
export async function resumeE2BSandbox(env: E2BEnv, sandboxId: string, ttlSeconds: number, signal: AbortSignal) {
  try {
    await connectE2BSandbox(env, sandboxId, signal, ttlSeconds * 1000);
  } catch (error) {
    if (error instanceof NotFoundError) throw new WorkspaceError({ reason: 'expired' });
    throw error;
  }
}

/** Irreversible. An already-gone sandbox is a success. */
export async function deleteE2BSandbox(env: E2BEnv, sandboxId: string, signal: AbortSignal) {
  await Sandbox.kill(sandboxId, { apiKey: apiKey(env), signal });
}

export async function inspectE2BSandbox(
  env: E2BEnv,
  sandboxId: string,
  signal: AbortSignal,
): Promise<Session['workspace']['state']> {
  try {
    const { state } = await Sandbox.getInfo(sandboxId, { apiKey: apiKey(env), signal });

    switch (state) {
      case 'running':
        return 'running';
      case 'paused':
        return 'stopped';
      default:
        throw new WorkspaceError({ reason: 'invalid_response' });
    }
  } catch (error) {
    if (error instanceof NotFoundError) return 'deleted';
    throw error;
  }
}
