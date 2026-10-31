/**
 * Path: server/src/tools/remote.ts
 * Used by: server/src/tools/{files,environment,commands,command-records}.ts.
 * Purpose: The only client of the sandbox file and command APIs: Boat and Docker adapters behind one interface, validated once.
 */
import { Buffer } from 'node:buffer';
import { posix } from 'node:path';

import { ResponseError } from '@boatdev/sdk';
import type { WorkspaceRecord } from '@cloud-swe/protocol/storage';
import { CommandDispatched, FileBytes, FileContent, FileWritten, RemoteFileInfo } from '@cloud-swe/protocol/tools';
import { FileError } from '@earendil-works/pi-durable/env';

import type { Env } from '../env.ts';
import {
  BoatApiError,
  boatClient,
  BoatCommandDispatched,
  BoatFileBytes,
  BoatFileInfo,
  BoatFileRead,
  BoatFileWritten,
  BoatFolderCreated,
} from '../workspaces/boat.ts';

export type ToolsEnv = Pick<Env, 'BOAT_API_KEY' | 'DOCKER_SANDBOX_URL' | 'DOCKER_SANDBOX_TOKEN'>;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

// Both backends return JSON bounded by size; each operation validates it once with its own schema.
async function boundedJson(response: Response): Promise<Json> {
  if (!response.body) throw new Error('Sandbox response missing');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';

  try {
    for (;;) {
      const chunk = await reader.read();

      if (chunk.done) break;
      size += chunk.value.byteLength;

      if (size > 2_000_000) throw new Error('Sandbox response too large');
      text += decoder.decode(chunk.value, { stream: true });
    }

    return JSON.parse(text + decoder.decode());
  } finally {
    await reader.cancel();
  }
}

// Upstream bodies are never surfaced: only the status decides the code.
function statusError(status: number) {
  return new FileError(status === 404 ? 'not_found' : status === 400 ? 'invalid' : 'unknown', 'Sandbox request failed');
}

interface Sandbox {
  readText(path: string, signal: AbortSignal): Promise<string>;
  readBase64(path: string, signal: AbortSignal): Promise<string>;
  write(path: string, content: string, signal: AbortSignal): Promise<void>;
  mkdir(path: string, signal: AbortSignal): Promise<void>;
  info(path: string, signal: AbortSignal): Promise<ReturnType<typeof RemoteFileInfo.parse>>;
  dispatch(command: string, signal: AbortSignal): Promise<void>;
}

// Boat reports a missing path as 400 sandbox_direct_failed, and only the message distinguishes it (verified live).
const BOAT_MISSING_PATH = /ENOENT|No such file or directory/;

async function boatFileError(response: Response) {
  const body = BoatApiError.safeParse(await boundedJson(response).catch(() => null));
  const message = body.success ? body.data.error.message : undefined;

  if (body.success && body.data.error.code === 'sandbox_direct_failed' && BOAT_MISSING_PATH.test(message ?? ''))
    return statusError(404);

  return statusError(response.status);
}

function dockerSandbox(env: ToolsEnv, workspace: WorkspaceRecord): Sandbox {
  async function request(
    route: string,
    signal: AbortSignal,
    body?: { path: string; content?: string } | { command: string },
  ) {
    if (!env.DOCKER_SANDBOX_URL || !env.DOCKER_SANDBOX_TOKEN) throw new Error('Missing sandbox configuration');

    const response = await fetch(new URL('/workspaces/' + workspace.sandboxId + route, env.DOCKER_SANDBOX_URL), {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + env.DOCKER_SANDBOX_TOKEN, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });

    if (!response.ok) throw statusError(response.status);

    return boundedJson(response);
  }

  const query = (route: string, path: string) => route + '?path=' + encodeURIComponent(path);

  return {
    readText: async (path, signal) => FileContent.parse(await request(query('/file', path), signal)).content,
    readBase64: async (path, signal) => FileBytes.parse(await request(query('/bytes', path), signal)).content,
    write: async (path, content, signal) => {
      FileWritten.parse(await request('/file', signal, { path, content }));
    },
    mkdir: async (path, signal) => {
      FileWritten.parse(await request('/directory', signal, { path }));
    },
    info: async (path, signal) => RemoteFileInfo.parse(await request(query('/info', path), signal)),
    dispatch: async (command, signal) => {
      CommandDispatched.parse(await request('/commands', signal, { command }));
    },
  };
}

function boatSandbox(env: ToolsEnv, workspace: WorkspaceRecord): Sandbox {
  const sandboxId = workspace.sandboxId;

  // No mode on mkdir: Boat applies it to existing directories, which fails with EPERM on /tmp.
  // The generated SDK throws ResponseError for any non-2xx before the raw body is available.
  // Read the raw body: its deserializers are not boundary validators.
  async function json(call: Promise<{ raw: Response }>) {
    try {
      return await boundedJson((await call).raw);
    } catch (error) {
      throw error instanceof ResponseError ? await boatFileError(error.response) : error;
    }
  }

  const mkdir: Sandbox['mkdir'] = async (path, signal) => {
    BoatFolderCreated.parse(
      await json(boatClient(env).createFolderRaw({ sandboxId, fileFolderRequest: { path } }, { signal })),
    );
  };

  return {
    readText: async (path, signal) =>
      BoatFileRead.parse(await json(boatClient(env).readFileRaw({ sandboxId, path, encoding: 'utf8' }, { signal })))
        .content,
    readBase64: async (path, signal) =>
      BoatFileBytes.parse(await json(boatClient(env).readFileRaw({ sandboxId, path, encoding: 'base64' }, { signal })))
        .content,
    write: async (path, content, signal) => {
      await mkdir(posix.dirname(path), signal);
      BoatFileWritten.parse(
        await json(
          boatClient(env).writeFileRaw(
            { sandboxId, fileWriteRequest: { path, content, encoding: 'utf8' } },
            { signal },
          ),
        ),
      );
    },
    mkdir,
    info: async (path, signal) => {
      const file = BoatFileInfo.parse(await json(boatClient(env).getFileInfoRaw({ sandboxId, path }, { signal })));

      return RemoteFileInfo.parse({
        path: file.path,
        name: file.name,
        size: file.size,
        mtimeMs: Date.parse(file.modifiedAt),
        kind: file.isSymlink ? 'symlink' : file.isDir ? 'directory' : 'file',
      });
    },
    dispatch: async (command, signal) => {
      BoatCommandDispatched.parse(
        await json(boatClient(env).commandRaw({ sandboxId, commandRequest: { command, detached: true } }, { signal })),
      );
    },
  };
}

const sandbox = (env: ToolsEnv, workspace: WorkspaceRecord) =>
  workspace.provider === 'docker' ? dockerSandbox(env, workspace) : boatSandbox(env, workspace);

function decodeFile(content: string): Uint8Array {
  const bytes = Buffer.from(content, 'base64');

  if (bytes.length > 5_242_880 || bytes.toString('base64') !== content)
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
): Promise<void> {
  // Boat's own limit for a direct write; measured, as its docs don't state it.
  if (new TextEncoder().encode(content).length > 5_242_880) throw new FileError('invalid', 'File exceeds 5 MiB');

  await sandbox(env, workspace).write(path, content, signal);
}

export const dispatchRemoteCommand = (
  env: ToolsEnv,
  workspace: WorkspaceRecord,
  command: string,
  signal: AbortSignal,
) => sandbox(env, workspace).dispatch(command, signal);

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
