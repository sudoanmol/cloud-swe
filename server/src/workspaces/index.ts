/**
 * Path: server/src/workspaces/index.ts
 * Used by: server/src/sandbox/command-records.ts, server/src/sessions/{create,workspace-lifecycle}.ts.
 * Purpose: Provisions a sandbox and waits until it is ready, with Effect retries and deadlines, on the E2B, Boat or Docker backend.
 */

import type { Session } from '@cloud-swe/protocol';
import type { SessionCreation } from '@cloud-swe/protocol/storage';
import { Effect, Schedule } from 'effect';

import type { Env } from '../env.ts';
import {
  createBoatSandbox,
  deleteBoatSandbox,
  findBoatSandbox,
  inspectBoatSandbox,
  renewBoatSandbox,
  resumeBoatSandbox,
} from './boat.ts';
import {
  createDockerWorkspace,
  deleteDockerWorkspace,
  inspectDockerWorkspace,
  renewDockerWorkspace,
  resumeDockerWorkspace,
} from './docker.ts';
import {
  createE2BSandbox,
  deleteE2BSandbox,
  findE2BSandbox,
  inspectE2BSandbox,
  renewE2BSandbox,
  resumeE2BSandbox,
} from './e2b.ts';
import { WorkspaceError, workspaceError } from './errors.ts';

export type WorkspaceEnv = Pick<
  Env,
  'WORKSPACE_BACKEND' | 'DOCKER_SANDBOX_URL' | 'DOCKER_SANDBOX_TOKEN' | 'BOAT_API_KEY' | 'E2B_API_KEY'
>;

type WorkspaceState = Session['workspace']['state'];

// Leave a margin before Boat's 24-hour idempotency window expires.
const PROVISION_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;

const BACKENDS = {
  docker: {
    inspect: inspectDockerWorkspace,
    renew: renewDockerWorkspace,
    resume: resumeDockerWorkspace,
    delete: deleteDockerWorkspace,
  },
  boat: {
    inspect: inspectBoatSandbox,
    renew: renewBoatSandbox,
    resume: resumeBoatSandbox,
    delete: deleteBoatSandbox,
  },
  e2b: {
    inspect: inspectE2BSandbox,
    renew: renewE2BSandbox,
    resume: resumeE2BSandbox,
    delete: deleteE2BSandbox,
  },
};

function backend(env: WorkspaceEnv) {
  // The binding is an unchecked string at runtime, so an unset or mistyped one fails closed here.
  if (!Object.hasOwn(BACKENDS, env.WORKSPACE_BACKEND)) throw new WorkspaceError({ reason: 'configuration' });

  return BACKENDS[env.WORKSPACE_BACKEND];
}

/** E2B's pause freezes processes and resume continues them. Boat's stop ends them, as does Docker's stand-in for it. */
export const stopKeepsProcesses = (env: Pick<Env, 'WORKSPACE_BACKEND'>) => env.WORKSPACE_BACKEND === 'e2b';

/** Recover a lost create receipt before dispatching another create. */
export function recoverOrProvisionWorkspace(
  env: WorkspaceEnv,
  creation: SessionCreation,
): Effect.Effect<string, WorkspaceError> {
  return Effect.gen(function* () {
    if (env.WORKSPACE_BACKEND === 'boat' || env.WORKSPACE_BACKEND === 'e2b') {
      const find = env.WORKSPACE_BACKEND === 'boat' ? findBoatSandbox : findE2BSandbox;

      const recovered = yield* Effect.tryPromise((signal) => find(env, creation, signal)).pipe(
        Effect.timeout('5 seconds'),
        Effect.mapError(workspaceError),
      );

      if (recovered !== null) return recovered;
    }

    if (Date.now() - Date.parse(creation.createdAt) > PROVISION_RETRY_WINDOW_MS) {
      return yield* Effect.fail(new WorkspaceError({ reason: 'uncertain' }));
    }

    return yield* provisionWorkspace(env, creation);
  });
}

/** Creates the session's own sandbox and returns the backend's identity for it. */
export function provisionWorkspace(
  env: WorkspaceEnv,
  creation: SessionCreation,
): Effect.Effect<string, WorkspaceError> {
  switch (env.WORKSPACE_BACKEND) {
    case 'docker':
      return Effect.tryPromise((signal) => createDockerWorkspace(env, creation.workspaceId, signal)).pipe(
        Effect.timeout('5 seconds'),
        Effect.mapError(workspaceError),
      );
    case 'boat':
      return createBoatSandbox(env, creation);
    case 'e2b':
      return createE2BSandbox(env, creation);
    default:
      return Effect.fail(new WorkspaceError({ reason: 'configuration' }));
  }
}

export function inspectWorkspace(env: WorkspaceEnv, sandboxId: string): Effect.Effect<WorkspaceState, WorkspaceError> {
  return Effect.tryPromise((signal) => backend(env).inspect(env, sandboxId, signal)).pipe(
    Effect.timeout('5 seconds'),
    Effect.mapError(workspaceError),
  );
}

/** Sets the sandbox's auto-stop deadline to now + ttlSeconds. */
export function renewWorkspace(
  env: WorkspaceEnv,
  sandboxId: string,
  ttlSeconds: number,
): Effect.Effect<void, WorkspaceError> {
  return Effect.tryPromise((signal) => backend(env).renew(env, sandboxId, ttlSeconds, signal)).pipe(
    Effect.timeout('10 seconds'),
    Effect.mapError(workspaceError),
  );
}

/** Starts a stopped sandbox with a fresh deadline. Fails with `expired` when it is gone. */
export function resumeWorkspace(
  env: WorkspaceEnv,
  sandboxId: string,
  ttlSeconds: number,
): Effect.Effect<void, WorkspaceError> {
  return Effect.tryPromise((signal) => backend(env).resume(env, sandboxId, ttlSeconds, signal)).pipe(
    Effect.timeout('30 seconds'),
    Effect.mapError(workspaceError),
  );
}

/** Irreversible; the sandbox and its disk are gone. */
export function deleteWorkspace(env: WorkspaceEnv, sandboxId: string): Effect.Effect<void, WorkspaceError> {
  return Effect.tryPromise((signal) => backend(env).delete(env, sandboxId, signal)).pipe(
    Effect.timeout('30 seconds'),
    Effect.mapError(workspaceError),
  );
}

/** Polls a sandbox until it leaves `pending` states (`starting` by default), or gives up and reports the last one. */
export function waitForWorkspace(
  env: WorkspaceEnv,
  sandboxId: string,
  pending: readonly WorkspaceState[] = ['starting'],
): Effect.Effect<WorkspaceState, WorkspaceError> {
  return inspectWorkspace(env, sandboxId).pipe(
    Effect.repeat({ times: 29, schedule: Schedule.spaced('2 seconds'), while: (state) => pending.includes(state) }),
    Effect.timeout('1 minute'),
    Effect.mapError(workspaceError),
  );
}
