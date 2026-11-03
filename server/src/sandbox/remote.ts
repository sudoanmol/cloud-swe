/**
 * Path: server/src/sandbox/remote.ts
 * Used by: server/src/git/{access,clone,tools}.ts, server/src/sandbox/{command-records,commands,egress,environment}.ts, server/src/tools/web-output.ts.
 * Purpose: The only client of the sandbox file and command APIs: E2B and the Docker test double behind one interface, validated once.
 */

import { Buffer } from 'node:buffer';

import type { WorkspaceRecord } from '@cloud-swe/protocol/storage';
import { CommandDispatched, FileBytes, FileContent, FileWritten, RemoteFileInfo } from '@cloud-swe/protocol/tools';
import { FileError } from '@earendil-works/pi-durable/env';
import { CommandExitError, FileType, InvalidArgumentError, NotFoundError, SandboxError } from 'e2b';

import type { Env } from '../env.ts';
import { DockerExecResult } from '../workspaces/docker.ts';
import { connectE2BSandbox } from '../workspaces/e2b.ts';
import { quote } from './runner.ts';

export type ToolsEnv = Pick<Env, 'E2B_API_KEY' | 'DOCKER_SANDBOX_URL' | 'DOCKER_SANDBOX_TOKEN'>;

// Our own bound on any file written or read as bytes, so one call can't hold the Worker's memory.
const MAX_FILE_BYTES = 5_242_880;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

async function boundedBytes(body: ReadableStream<Uint8Array>, limit: number): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      const chunk = await reader.read();

      if (chunk.done) return Buffer.concat(chunks);
      size += chunk.value.byteLength;

      if (size > limit) throw new Error('Sandbox response too large');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
}

// The Docker double returns JSON bounded by size; each operation validates it once with its own schema.
async function boundedJson(response: Response): Promise<Json> {
  if (!response.body) throw new Error('Sandbox response missing');

  return JSON.parse((await boundedBytes(response.body, 2_000_000)).toString());
}

// Upstream bodies are never surfaced: only the status decides the code.
function statusError(status: number) {
  if (status === 404) return new FileError('not_found', 'Sandbox request failed');

  return new FileError(status === 400 ? 'invalid' : 'unknown', 'Sandbox request failed');
}

// Platform setup outside the agent's commands, such as the network-secret daemon, runs as root.
export type RemoteUser = 'root' | undefined;

type ExecResult = { exitCode: number; stdout: string };

interface Sandbox {
  readText(path: string, signal: AbortSignal): Promise<string>;
  readBase64(path: string, signal: AbortSignal): Promise<string>;
  write(path: string, content: string, signal: AbortSignal, user: RemoteUser): Promise<void>;
  mkdir(path: string, signal: AbortSignal): Promise<void>;
  info(path: string, signal: AbortSignal): Promise<ReturnType<typeof RemoteFileInfo.parse>>;
  dispatch(command: string, signal: AbortSignal): Promise<void>;
  exec(command: string, user: RemoteUser, timeoutMs: number, signal: AbortSignal): Promise<ExecResult>;
}

function dockerSandbox(env: ToolsEnv, workspace: WorkspaceRecord): Sandbox {
  async function request(
    route: string,
    signal: AbortSignal,
    body?: { path: string; content?: string; user?: 'root' } | { command: string; user?: 'root'; timeoutMs?: number },
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

function e2bSandbox(env: ToolsEnv, workspace: WorkspaceRecord): Sandbox {
  type Client = Awaited<ReturnType<typeof connectE2BSandbox>>;

  // A Worker can't hold a connection between requests, so each call connects. That also resumes a paused sandbox, so a
  // command being polled continues after E2B pauses the sandbox at its plan's limit. Callers must therefore only reach
  // the sandbox when it may run: a run's tools and keep-alive, a message admitted past the cap, or stopping orphans.
  async function on<Result>(signal: AbortSignal, call: (client: Client) => Promise<Result>): Promise<Result> {
    try {
      return await call(await connectE2BSandbox(env, workspace.sandboxId, signal));
    } catch (error) {
      if (error instanceof NotFoundError) throw statusError(404);
      throw statusError(error instanceof InvalidArgumentError ? 400 : 500);
    }
  }

  const read = (path: string, signal: AbortSignal) =>
    on(signal, async (client) =>
      boundedBytes(await client.files.read(path, { format: 'stream', signal }), MAX_FILE_BYTES),
    );

  return {
    readText: async (path, signal) => FileContent.parse({ content: (await read(path, signal)).toString() }).content,
    readBase64: async (path, signal) =>
      FileBytes.parse({ content: (await read(path, signal)).toString('base64'), encoding: 'base64' }).content,
    write: (path, content, signal, user) =>
      on(signal, async (client) => {
        if (user === 'root') {
          await client.files.write(path, content, { signal, user });

          return;
        }

        try {
          await client.files.write(path, content, { signal });
        } catch (error) {
          if (!(error instanceof SandboxError && error.message.includes('permission denied'))) throw error;
          // E2B's file API opens files as root, and fs.protected_regular stops that reopening another user's file in a
          // sticky directory such as /tmp, even when told to write as its owner. Writing as root works in place, keeping
          // the file's mode and links, but hands it to root, so the owner is restored (verified live).
          const { owner, group } = await client.files.getInfo(path, { signal });
          await client.files.write(path, content, { signal, user: 'root' });
          await client.commands.run(`chown -- ${quote(`${owner}:${group}`)} ${quote(path)}`, { user: 'root', signal });
        }
      }),
    mkdir: (path, signal) =>
      on(signal, async (client) => {
        await client.files.makeDir(path, { signal });
      }),
    info: (path, signal) =>
      on(signal, async (client) => {
        const file = await client.files.getInfo(path, { signal });
        const kind = file.type === FileType.DIR ? 'directory' : 'file';

        return RemoteFileInfo.parse({
          path: file.path,
          name: file.name,
          size: file.size,
          mtimeMs: file.modifiedTime?.getTime() ?? 0,
          kind: file.symlinkTarget === undefined ? kind : 'symlink',
        });
      }),
    dispatch: (command, signal) =>
      on(signal, async (client) => {
        // Detached: the process keeps running after this request ends, and reports through its progress file.
        const handle = await client.commands.run(command, { background: true, timeoutMs: 0, signal });
        await handle.disconnect();
      }),
    exec: (command, user, timeoutMs, signal) =>
      on(signal, async (client) => {
        try {
          const { exitCode, stdout } = await client.commands.run(command, { user, timeoutMs, signal });

          return { exitCode, stdout };
        } catch (error) {
          // A non-zero exit is a result, not a failure of the call.
          if (error instanceof CommandExitError) return { exitCode: error.exitCode, stdout: error.stdout };
          throw error;
        }
      }),
  };
}

function sandbox(env: ToolsEnv, workspace: WorkspaceRecord): Sandbox {
  switch (workspace.provider) {
    case 'docker':
      return dockerSandbox(env, workspace);
    case 'e2b':
      return e2bSandbox(env, workspace);
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

/** The sandbox's working directory, as an absolute path. */
export async function sandboxRoot(env: ToolsEnv, workspace: WorkspaceRecord): Promise<string> {
  return (await remoteFileInfo(env, workspace, '.', AbortSignal.timeout(5000))).path;
}
