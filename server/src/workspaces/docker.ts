/**
 * Path: server/src/workspaces/docker.ts
 * Used by: server/src/workspaces/index.ts.
 * Purpose: The Docker test backend and the schemas of its sandbox service; clients never see these.
 */

import { WorkspaceId } from '@cloud-swe/protocol';
import { z } from 'zod';

import type { Env } from '../env.ts';
import { isRefusal, WorkspaceError } from './errors.ts';

export const DockerWorkspaceInfo = z.strictObject({
  provider: z.literal('docker'),
  id: WorkspaceId,
  state: z.enum(['running', 'starting', 'stopped']),
  root: z.string().regex(/^\/workspace\/[0-9a-f-]{36}$/),
});

export const DockerPath = z.strictObject({ path: z.string().min(1).max(4096) });

export const DockerCommand = z.strictObject({ command: z.string().min(1).max(100_000) });

export const DockerFileWrite = z.strictObject({
  path: z.string().min(1).max(4096),
  content: z.string().max(5_242_880),
});

export const DockerTtl = z.strictObject({ ttlSeconds: z.number().int().positive() });

export type DockerTtl = z.infer<typeof DockerTtl>;

type DockerEnv = Pick<Env, 'DOCKER_SANDBOX_URL' | 'DOCKER_SANDBOX_TOKEN'>;

type Method = 'GET' | 'PUT' | 'POST' | 'DELETE';

async function workspaceRequest(
  env: DockerEnv,
  method: Method,
  sandboxId: string,
  signal: AbortSignal,
  route = '',
  body?: DockerTtl,
) {
  if (!env.DOCKER_SANDBOX_URL || !env.DOCKER_SANDBOX_TOKEN) {
    throw new WorkspaceError({ reason: 'configuration' });
  }

  const parsedId = WorkspaceId.safeParse(sandboxId);

  if (!parsedId.success) throw new WorkspaceError({ reason: 'invalid_response' });
  const id = parsedId.data;

  const response = await fetch(new URL(`/workspaces/${id}${route}`, env.DOCKER_SANDBOX_URL), {
    method,
    headers: { Authorization: `Bearer ${env.DOCKER_SANDBOX_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  // Like Boat, the test double answers 404 for a deleted sandbox.
  if (response.status === 404) return 'gone' as const;

  if (!response.ok) throw new WorkspaceError({ reason: isRefusal(response.status) ? 'refused' : 'unavailable' });

  const parsed = DockerWorkspaceInfo.safeParse(await response.json());

  if (!parsed.success || parsed.data.id !== id) throw new WorkspaceError({ reason: 'invalid_response' });

  return parsed.data.state;
}

// The Docker test double names each workspace directory by its app workspace ID.
export async function createDockerWorkspace(env: DockerEnv, workspaceId: string, signal: AbortSignal): Promise<string> {
  await workspaceRequest(env, 'PUT', workspaceId, signal);

  return workspaceId;
}

export async function inspectDockerWorkspace(env: DockerEnv, sandboxId: string, signal: AbortSignal) {
  const state = await workspaceRequest(env, 'GET', sandboxId, signal);

  return state === 'gone' ? 'deleted' : state;
}

export async function renewDockerWorkspace(env: DockerEnv, sandboxId: string, ttlSeconds: number, signal: AbortSignal) {
  if ((await workspaceRequest(env, 'POST', sandboxId, signal, '/ttl', { ttlSeconds })) === 'gone')
    throw new WorkspaceError({ reason: 'expired' });
}

export async function resumeDockerWorkspace(
  env: DockerEnv,
  sandboxId: string,
  ttlSeconds: number,
  signal: AbortSignal,
) {
  if ((await workspaceRequest(env, 'POST', sandboxId, signal, '/resume', { ttlSeconds })) === 'gone')
    throw new WorkspaceError({ reason: 'expired' });
}

export async function deleteDockerWorkspace(env: DockerEnv, sandboxId: string, signal: AbortSignal) {
  await workspaceRequest(env, 'DELETE', sandboxId, signal);
}
