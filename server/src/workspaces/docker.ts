/**
 * Path: server/src/workspaces/docker.ts
 * Used by: server/src/sandbox/remote.ts, server/src/workspaces/index.ts.
 * Purpose: The Docker test backend: its sandbox service's lifecycle and file and command routes; clients never see these.
 */

import { Buffer } from 'node:buffer';

import { WorkspaceId } from '@cloud-swe/protocol';
import { CommandDispatched, FileBytes, FileContent, FileWritten, RemoteFileInfo } from '@cloud-swe/protocol/tools';
import { FileError } from '@earendil-works/pi-durable/env';
import { z } from 'zod';

import type { Env } from '../env.ts';
import { isRefusal, WorkspaceError } from './errors.ts';
import { boundedBytes, type RemoteUser, type SandboxApi, statusError } from './provider.ts';

export const DockerWorkspaceInfo = z.strictObject({
  provider: z.literal('docker'),
  id: WorkspaceId,
  state: z.enum(['running', 'starting', 'stopped']),
  root: z.string().regex(/^\/workspace\/[0-9a-f-]{36}$/),
});

export const DockerExecResult = z.strictObject({ exitCode: z.int(), stdout: z.string().max(65_536) });

type DockerEnv = Pick<Env, 'DOCKER_SANDBOX_URL' | 'DOCKER_SANDBOX_TOKEN'>;

type Method = 'GET' | 'PUT' | 'POST' | 'DELETE';

type Body =
  | { ttlSeconds: number }
  | { path: string; content?: string; user?: RemoteUser }
  | { command: string; user?: RemoteUser; timeoutMs?: number };

async function dockerFetch(
  env: DockerEnv,
  method: Method,
  sandboxId: string,
  route: string,
  signal: AbortSignal,
  body?: Body,
): Promise<Response> {
  if (!env.DOCKER_SANDBOX_URL || !env.DOCKER_SANDBOX_TOKEN) throw new WorkspaceError({ reason: 'configuration' });

  return fetch(new URL(`/workspaces/${sandboxId}${route}`, env.DOCKER_SANDBOX_URL), {
    method,
    headers: { Authorization: `Bearer ${env.DOCKER_SANDBOX_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
}

async function workspaceRequest(
  env: DockerEnv,
  method: Method,
  sandboxId: string,
  signal: AbortSignal,
  route = '',
  body?: Body,
) {
  const parsedId = WorkspaceId.safeParse(sandboxId);

  if (!parsedId.success) throw new WorkspaceError({ reason: 'invalid_response' });
  const id = parsedId.data;
  const response = await dockerFetch(env, method, id, route, signal, body);

  // The test double answers 404 for a deleted sandbox.
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

const setDeadline =
  (route: '/ttl' | '/resume') => async (env: DockerEnv, sandboxId: string, ttlSeconds: number, signal: AbortSignal) => {
    if ((await workspaceRequest(env, 'POST', sandboxId, signal, route, { ttlSeconds })) === 'gone')
      throw new WorkspaceError({ reason: 'expired' });
  };

export const renewDockerWorkspace = setDeadline('/ttl');

export const resumeDockerWorkspace = setDeadline('/resume');

export async function deleteDockerWorkspace(env: DockerEnv, sandboxId: string, signal: AbortSignal) {
  await workspaceRequest(env, 'DELETE', sandboxId, signal);
}

// The Docker double returns JSON bounded by size; each operation validates it once with its own schema.
async function boundedJson(response: Response) {
  if (!response.body) throw new Error('Sandbox response missing');

  return JSON.parse((await boundedBytes(response.body, 2_000_000)).toString());
}

export function dockerSandbox(env: DockerEnv, sandboxId: string): SandboxApi {
  async function request(route: string, signal: AbortSignal, body?: Body) {
    const response = await dockerFetch(env, body ? 'POST' : 'GET', sandboxId, route, signal, body);

    if (!response.ok) throw statusError(response.status);

    return boundedJson(response);
  }

  const query = (route: string, path: string) => route + '?path=' + encodeURIComponent(path);

  return {
    readText: async (path, signal) => FileContent.parse(await request(query('/file', path), signal)).content,
    readBytes: async (path, signal) => {
      const { content } = FileBytes.parse(await request(query('/bytes', path), signal));
      const bytes = Buffer.from(content, 'base64');

      if (bytes.toString('base64') !== content) throw new FileError('invalid', 'Invalid or oversized sandbox file');

      return bytes;
    },
    write: async (path, content, signal, user) => {
      FileWritten.parse(await request('/file', signal, { path, content, user }));
    },
    mkdir: async (path, signal) => {
      FileWritten.parse(await request('/directory', signal, { path }));
    },
    info: async (path, signal) => RemoteFileInfo.parse(await request(query('/info', path), signal)),
    dispatch: async (command, signal) => {
      CommandDispatched.parse(await request('/commands', signal, { command }));
    },
    exec: async (command, user, timeoutMs, signal) =>
      DockerExecResult.parse(await request('/exec', signal, { command, user, timeoutMs })),
  };
}
