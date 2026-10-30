import type { Session } from '@cloud-swe/protocol';
import type { SessionCreation } from '@cloud-swe/protocol/storage';
import { Effect, Schedule } from 'effect';

import type { Env } from '../env';
import { createBoatSandbox, inspectBoatSandbox } from './boat.ts';
import { createDockerWorkspace, inspectDockerWorkspace } from './docker.ts';
import { WorkspaceError, workspaceError } from './errors.ts';

export type WorkspaceEnv = Pick<
  Env,
  'WORKSPACE_BACKEND' | 'DOCKER_SANDBOX_URL' | 'DOCKER_SANDBOX_TOKEN' | 'BOAT_API_KEY'
>;

type WorkspaceState = Session['workspace']['state'];

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
    default:
      return Effect.fail(new WorkspaceError({ reason: 'configuration' }));
  }
}

export function inspectWorkspace(env: WorkspaceEnv, sandboxId: string): Effect.Effect<WorkspaceState, WorkspaceError> {
  return Effect.tryPromise((signal) => {
    switch (env.WORKSPACE_BACKEND) {
      case 'docker':
        return inspectDockerWorkspace(env, sandboxId, signal);
      case 'boat':
        return inspectBoatSandbox(env, sandboxId, signal);
      default:
        throw new WorkspaceError({ reason: 'configuration' });
    }
  }).pipe(Effect.timeout('5 seconds'), Effect.mapError(workspaceError));
}

/** Polls a new sandbox until it leaves `starting`, or gives up and reports `starting`. */
export function waitForWorkspace(env: WorkspaceEnv, sandboxId: string): Effect.Effect<WorkspaceState, WorkspaceError> {
  return inspectWorkspace(env, sandboxId).pipe(
    Effect.repeat({ times: 29, schedule: Schedule.spaced('2 seconds'), while: (state) => state === 'starting' }),
    Effect.timeout('1 minute'),
    Effect.mapError(workspaceError),
  );
}
