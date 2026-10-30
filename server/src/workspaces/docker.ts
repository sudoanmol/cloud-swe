import { WorkspaceId } from '@cloud-swe/protocol';
import { DockerWorkspaceInfo } from '@cloud-swe/protocol/workspace';

import type { Env } from '../env';

type DockerEnv = Pick<Env, 'DOCKER_SANDBOX_URL' | 'DOCKER_SANDBOX_TOKEN'>;

async function workspaceRequest(env: DockerEnv, method: 'GET' | 'PUT', sandboxId: string): Promise<void> {
  if (!env.DOCKER_SANDBOX_URL || !env.DOCKER_SANDBOX_TOKEN) throw new Error('Docker not configured');

  const id = WorkspaceId.parse(sandboxId);

  const response = await fetch(new URL(`/workspaces/${id}`, env.DOCKER_SANDBOX_URL), {
    method,
    headers: { Authorization: `Bearer ${env.DOCKER_SANDBOX_TOKEN}` },
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) throw new Error('Docker unavailable');

  if (DockerWorkspaceInfo.parse(await response.json()).id !== id) throw new Error('Docker workspace mismatch');
}

// The Docker test double names each workspace directory by its app workspace ID.
export async function createDockerWorkspace(env: DockerEnv, workspaceId: string): Promise<string> {
  await workspaceRequest(env, 'PUT', workspaceId);

  return workspaceId;
}

export async function inspectDockerWorkspace(env: DockerEnv, sandboxId: string): Promise<'running'> {
  await workspaceRequest(env, 'GET', sandboxId);

  return 'running';
}
