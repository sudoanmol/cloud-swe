/**
 * Path: server/src/sandbox/remote.ts
 * Used by: server/src/git/{access,clone,tools}.ts, server/src/sandbox/{command-records,commands,egress,environment,runner}.ts, server/src/tools/web-output.ts.
 * Purpose: The only client of the sandbox file and command APIs: picks the session's provider and bounds file sizes.
 */

import { Buffer } from 'node:buffer';
import { posix } from 'node:path';

import type { WorkspaceRecord } from '@cloud-swe/protocol/storage';
import { MAX_FILE_BYTES } from '@cloud-swe/protocol/tools';
import { FileError } from '@earendil-works/pi-durable/env';

import type { Env } from '../env.ts';
import { dockerSandbox } from '../workspaces/docker.ts';
import { e2bSandbox } from '../workspaces/e2b.ts';
import type { RemoteUser, SandboxApi } from '../workspaces/provider.ts';

export type ToolsEnv = Pick<Env, 'E2B_API_KEY' | 'DOCKER_SANDBOX_URL' | 'DOCKER_SANDBOX_TOKEN'>;

function sandbox(env: ToolsEnv, workspace: WorkspaceRecord): SandboxApi {
  switch (workspace.provider) {
    case 'docker':
      return dockerSandbox(env, workspace.sandboxId);
    case 'e2b':
      return e2bSandbox(env, workspace.sandboxId);
  }
}

function decodeFile(content: string): Uint8Array {
  const bytes = Buffer.from(content, 'base64');

  if (bytes.length > MAX_FILE_BYTES || bytes.toString('base64') !== content)
    throw new FileError('invalid', 'Invalid or oversized sandbox file');

  return bytes;
}

export const readRemoteFile = (env: ToolsEnv, workspace: WorkspaceRecord, path: string, signal: AbortSignal) =>
  sandbox(env, workspace).readText(path, signal);

export async function writeRemoteFile(
  env: ToolsEnv,
  workspace: WorkspaceRecord,
  path: string,
  content: string,
  signal: AbortSignal,
  user?: RemoteUser,
): Promise<void> {
  if (new TextEncoder().encode(content).length > MAX_FILE_BYTES) throw new FileError('invalid', 'File exceeds 5 MiB');

  await sandbox(env, workspace).write(path, content, signal, user);
}

export const dispatchRemoteCommand = (
  env: ToolsEnv,
  workspace: WorkspaceRecord,
  command: string,
  signal: AbortSignal,
) => sandbox(env, workspace).dispatch(command, signal);

/**
 * Runs a short platform command to its end and returns its exit code and output. Never for agent commands: those go
 * through the supervisor, so a lost receipt can't run them twice. Its text must hold no secret (E2B logs it).
 */
export const runRemoteCommand = (
  env: ToolsEnv,
  workspace: WorkspaceRecord,
  command: string,
  user: RemoteUser,
  timeoutMs: number,
) => sandbox(env, workspace).exec(command, user, timeoutMs, AbortSignal.timeout(timeoutMs + 5000));

export async function readRemoteBytes(
  env: ToolsEnv,
  workspace: WorkspaceRecord,
  path: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  return decodeFile(await sandbox(env, workspace).readBase64(path, signal));
}

export const createRemoteDirectory = (env: ToolsEnv, workspace: WorkspaceRecord, path: string, signal: AbortSignal) =>
  sandbox(env, workspace).mkdir(path, signal);

export const remoteFileInfo = (env: ToolsEnv, workspace: WorkspaceRecord, path: string, signal: AbortSignal) =>
  sandbox(env, workspace).info(path, signal);

export async function sandboxRoot(env: ToolsEnv, workspace: WorkspaceRecord): Promise<string> {
  const { path } = await remoteFileInfo(env, workspace, '.', AbortSignal.timeout(5000));

  if (!path.startsWith('/')) throw new Error('Sandbox did not return an absolute working directory');

  return path.replace(/(.)\/$/, '$1');
}

export const platformPath = (root: string, name: string) => posix.join(root, '.cloud-swe', name);

export const tempPath = (workspaceId: string, name: string) => '/tmp/cloud-swe-' + workspaceId + '-' + name;
