/**
 * Path: server/src/workspaces/index.ts
 * Used by: server/src/sessions/{create,workspace-lifecycle}.ts.
 * Purpose: Provisions a sandbox and waits until it is ready, with Effect retries and deadlines, on E2B, or the Docker test double.
 */

import type { Session } from '@cloud-swe/protocol';
import type { SessionCreation } from '@cloud-swe/protocol/storage';
import { type Duration, Effect, Schedule } from 'effect';

import type { Env } from '../env.ts';
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
  'WORKSPACE_BACKEND' | 'DOCKER_SANDBOX_URL' | 'DOCKER_SANDBOX_TOKEN' | 'E2B_API_KEY'
>;

type WorkspaceState = Session['workspace']['state'];

const attempt = <A>(timeout: Duration.Input, run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise(run).pipe(Effect.timeout(timeout), Effect.mapError(workspaceError));

const BACKENDS = {
  docker: {
    // The Docker double's create is idempotent itself, so there is nothing to recover.
    recover: () => Effect.succeed(null),
    create: (env: WorkspaceEnv, creation: SessionCreation) =>
      attempt('5 seconds', (signal) => createDockerWorkspace(env, creation.workspaceId, signal)),
    inspect: inspectDockerWorkspace,
    renew: renewDockerWorkspace,
    resume: resumeDockerWorkspace,
    delete: deleteDockerWorkspace,
  },
  e2b: {
    recover: (env: WorkspaceEnv, creation: SessionCreation) =>
      attempt('5 seconds', (signal) => findE2BSandbox(env, creation, signal)),
    create: createE2BSandbox,
    inspect: inspectE2BSandbox,
    renew: renewE2BSandbox,
    resume: resumeE2BSandbox,
    delete: deleteE2BSandbox,
  },
};

function backend(env: WorkspaceEnv) {
  // The binding is an unchecked string at runtime, so an unset or mistyped one fails closed here.
  return Object.hasOwn(BACKENDS, env.WORKSPACE_BACKEND)
    ? Effect.succeed(BACKENDS[env.WORKSPACE_BACKEND])
    : Effect.fail(new WorkspaceError({ reason: 'configuration' }));
}

/** Recover a lost create receipt before dispatching another create: E2B has no idempotency key. */
export function recoverOrProvisionWorkspace(
  env: WorkspaceEnv,
  creation: SessionCreation,
): Effect.Effect<string, WorkspaceError> {
  return Effect.gen(function* () {
    const { recover, create } = yield* backend(env);

    return (yield* recover(env, creation)) ?? (yield* create(env, creation));
  });
}

export function provisionWorkspace(
  env: WorkspaceEnv,
  creation: SessionCreation,
): Effect.Effect<string, WorkspaceError> {
  return Effect.flatMap(backend(env), ({ create }) => create(env, creation));
}

export function inspectWorkspace(env: WorkspaceEnv, sandboxId: string): Effect.Effect<WorkspaceState, WorkspaceError> {
  return Effect.flatMap(backend(env), ({ inspect }) =>
    attempt('5 seconds', (signal) => inspect(env, sandboxId, signal)),
  );
}

/** Sets the sandbox's auto-stop deadline to now + ttlSeconds. */
export function renewWorkspace(
  env: WorkspaceEnv,
  sandboxId: string,
  ttlSeconds: number,
): Effect.Effect<void, WorkspaceError> {
  return Effect.flatMap(backend(env), ({ renew }) =>
    attempt('10 seconds', (signal) => renew(env, sandboxId, ttlSeconds, signal)),
  );
}

/** Starts a stopped sandbox with a fresh deadline. Fails with `expired` when it is gone. */
export function resumeWorkspace(
  env: WorkspaceEnv,
  sandboxId: string,
  ttlSeconds: number,
): Effect.Effect<void, WorkspaceError> {
  return Effect.flatMap(backend(env), ({ resume }) =>
    attempt('30 seconds', (signal) => resume(env, sandboxId, ttlSeconds, signal)),
  );
}

/** Irreversible; the sandbox and its disk are gone. */
export function deleteWorkspace(env: WorkspaceEnv, sandboxId: string): Effect.Effect<void, WorkspaceError> {
  return Effect.flatMap(backend(env), ({ delete: remove }) =>
    attempt('30 seconds', (signal) => remove(env, sandboxId, signal)),
  );
}

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
