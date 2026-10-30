import { WorkspaceId } from '@cloud-swe/protocol';

import type { Env } from '../env';
import { DockerWorkspaceInfo } from './docker-schemas.ts';
import { WorkspaceError } from './errors.ts';

type DockerEnv = Pick<Env, 'DOCKER_SANDBOX_URL' | 'DOCKER_SANDBOX_TOKEN'>;

async function workspaceRequest(
  env: DockerEnv,
  method: 'GET' | 'PUT',
  sandboxId: string,
  signal: AbortSignal,
): Promise<void> {
  if (!env.DOCKER_SANDBOX_URL || !env.DOCKER_SANDBOX_TOKEN) {
    throw new WorkspaceError({ reason: 'configuration' });
  }

  const parsedId = WorkspaceId.safeParse(sandboxId);

  if (!parsedId.success) throw new WorkspaceError({ reason: 'invalid_response' });
  const id = parsedId.data;

  const response = await fetch(new URL(`/workspaces/${id}`, env.DOCKER_SANDBOX_URL), {
    method,
    headers: { Authorization: `Bearer ${env.DOCKER_SANDBOX_TOKEN}` },
    signal,
  });

  if (!response.ok) throw new WorkspaceError({ reason: 'unavailable' });

  const parsed = DockerWorkspaceInfo.safeParse(await response.json());

  if (!parsed.success || parsed.data.id !== id) throw new WorkspaceError({ reason: 'invalid_response' });
}

// The Docker test double names each workspace directory by its app workspace ID.
export async function createDockerWorkspace(env: DockerEnv, workspaceId: string, signal: AbortSignal): Promise<string> {
  await workspaceRequest(env, 'PUT', workspaceId, signal);

  return workspaceId;
}

export async function inspectDockerWorkspace(
  env: DockerEnv,
  sandboxId: string,
  signal: AbortSignal,
): Promise<'running'> {
  await workspaceRequest(env, 'GET', sandboxId, signal);

  return 'running';
}
