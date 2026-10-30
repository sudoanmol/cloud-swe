import { setTimeout as sleep } from 'node:timers/promises';

import type { Session } from '@cloud-swe/protocol';
import type { SessionCreation } from '@cloud-swe/protocol/storage';

import type { Env } from '../env';
import { createBoatSandbox, inspectBoatSandbox } from './boat.ts';
import { createDockerWorkspace, inspectDockerWorkspace } from './docker.ts';

export type WorkspaceEnv = Pick<
  Env,
  'WORKSPACE_BACKEND' | 'DOCKER_SANDBOX_URL' | 'DOCKER_SANDBOX_TOKEN' | 'BOAT_API_KEY'
>;

type WorkspaceState = Session['workspace']['state'];

const READY_ATTEMPTS = 30;
const READY_INTERVAL_MS = 2000;

/** Creates the session's own sandbox and returns the backend's identity for it. */
export async function provisionWorkspace(env: WorkspaceEnv, creation: SessionCreation): Promise<string> {
  switch (env.WORKSPACE_BACKEND) {
    case 'docker':
      return createDockerWorkspace(env, creation.workspaceId);
    case 'boat':
      return createBoatSandbox(env, creation);
    default:
      throw new Error('Workspace backend not configured');
  }
}

export async function inspectWorkspace(env: WorkspaceEnv, sandboxId: string): Promise<WorkspaceState> {
  switch (env.WORKSPACE_BACKEND) {
    case 'docker':
      return inspectDockerWorkspace(env, sandboxId);
    case 'boat':
      return inspectBoatSandbox(env, sandboxId);
    default:
      throw new Error('Workspace backend not configured');
  }
}

/** Polls a new sandbox until it leaves `starting`, or gives up and reports `starting`. */
export async function waitForWorkspace(env: WorkspaceEnv, sandboxId: string): Promise<WorkspaceState> {
  for (let attempt = 1; ; attempt++) {
    const state = await inspectWorkspace(env, sandboxId);

    if (state !== 'starting' || attempt === READY_ATTEMPTS) return state;

    await sleep(READY_INTERVAL_MS);
  }
}
