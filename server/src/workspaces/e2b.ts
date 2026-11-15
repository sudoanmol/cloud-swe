/**
 * Path: server/src/workspaces/e2b.ts
 * Used by: server/src/sandbox/remote.ts, server/src/workspaces/index.ts.
 * Purpose: The E2B backend: sandbox create, recover, renew, resume, inspect and delete, and its file and command API. Pausing keeps files and running processes.
 */

import type { Session } from '@cloud-swe/protocol';
import type { SessionCreation } from '@cloud-swe/protocol/storage';
import { FileBytes, FileContent, MAX_FILE_BYTES, RemoteFileInfo } from '@cloud-swe/protocol/tools';
import {
  AuthenticationError,
  CommandExitError,
  FileType,
  InvalidArgumentError,
  NotFoundError,
  Sandbox,
  SandboxError,
} from 'e2b';
import { Effect } from 'effect';

import type { Env } from '../env.ts';
import { quote } from '../shell.ts';
import { isRefusal, workspaceError, WorkspaceError } from './errors.ts';
import { boundedBytes, type SandboxApi, statusError } from './provider.ts';
import { IDLE_TTL_SECONDS } from './settings.ts';

type E2BEnv = Pick<Env, 'E2B_API_KEY'>;

// E2B has no idempotency key on create, so a lost create is found again by this metadata.
const WORKSPACE_METADATA = 'cloudSweWorkspace';

function apiKey(env: E2BEnv): string {
  if (!env.E2B_API_KEY) throw new WorkspaceError({ reason: 'configuration' });

  return env.E2B_API_KEY;
}

export function createE2BSandbox(env: E2BEnv, creation: SessionCreation): Effect.Effect<string, WorkspaceError> {
  return Effect.tryPromise((signal) =>
    Sandbox.create(creation.request.template, {
      apiKey: apiKey(env),
      signal,
      timeoutMs: IDLE_TTL_SECONDS * 1000,
      metadata: { [WORKSPACE_METADATA]: creation.workspaceId },
      lifecycle: { onTimeout: 'pause', autoResume: false },
    }),
  ).pipe(
    Effect.timeout('30 seconds'),
    Effect.mapError((failure) => {
      const { cause } = failure;

      // A refusal means no sandbox exists, so the caller may release its slot.
      return cause instanceof AuthenticationError ||
        (cause instanceof SandboxError && cause.statusCode !== undefined && isRefusal(cause.statusCode))
        ? new WorkspaceError({ reason: 'refused' })
        : workspaceError(failure);
    }),
    Effect.map((sandbox) => sandbox.sandboxId),
  );
}

export async function findE2BSandbox(
  env: E2BEnv,
  creation: SessionCreation,
  signal: AbortSignal,
): Promise<string | null> {
  const pages = Sandbox.list({
    apiKey: apiKey(env),
    limit: 2,
    query: { metadata: { [WORKSPACE_METADATA]: creation.workspaceId } },
  });

  const matches = await pages.nextItems({ signal });

  // Never guess which sandbox belongs to an intent, or treat a truncated result as absence.
  if (pages.hasNext || matches.length > 1) throw new WorkspaceError({ reason: 'uncertain' });

  return matches[0]?.sandboxId ?? null;
}

/** Connecting resumes a paused sandbox and only ever raises its deadline, to at least five minutes by default. */
const connectE2BSandbox = (env: E2BEnv, sandboxId: string, signal: AbortSignal, timeoutMs?: number) =>
  Sandbox.connect(sandboxId, { apiKey: apiKey(env), signal, timeoutMs });

/** Sets the deadline to now + ttlSeconds, lower or higher. Fails on a paused sandbox, as if it were missing. */
export async function renewE2BSandbox(env: E2BEnv, sandboxId: string, ttlSeconds: number, signal: AbortSignal) {
  await Sandbox.setTimeout(sandboxId, ttlSeconds * 1000, { apiKey: apiKey(env), signal });
}

/** Also what an active run renews with, because E2B pauses a sandbox at its plan's limit even mid-run. */
export async function resumeE2BSandbox(env: E2BEnv, sandboxId: string, ttlSeconds: number, signal: AbortSignal) {
  try {
    await connectE2BSandbox(env, sandboxId, signal, ttlSeconds * 1000);
  } catch (error) {
    if (error instanceof NotFoundError) throw new WorkspaceError({ reason: 'expired' });
    throw error;
  }
}

/** Irreversible. An already-gone sandbox is a success. */
export async function deleteE2BSandbox(env: E2BEnv, sandboxId: string, signal: AbortSignal) {
  await Sandbox.kill(sandboxId, { apiKey: apiKey(env), signal });
}

export async function inspectE2BSandbox(
  env: E2BEnv,
  sandboxId: string,
  signal: AbortSignal,
): Promise<Session['workspace']['state']> {
  try {
    const { state } = await Sandbox.getInfo(sandboxId, { apiKey: apiKey(env), signal });

    switch (state) {
      case 'running':
        return 'running';
      case 'paused':
        return 'stopped';
      default:
        throw new WorkspaceError({ reason: 'invalid_response' });
    }
  } catch (error) {
    if (error instanceof NotFoundError) return 'deleted';
    throw error;
  }
}

export function e2bSandbox(env: E2BEnv, sandboxId: string): SandboxApi {
  type Client = Awaited<ReturnType<typeof connectE2BSandbox>>;

  // A Worker can't hold a connection between requests, so each call connects. That also resumes a paused sandbox, so a
  // command being polled continues after E2B pauses the sandbox at its plan's limit. Callers must therefore only reach
  // the sandbox when it may run: a run's tools and keep-alive, a message admitted past the cap, or stopping orphans.
  async function on<Result>(signal: AbortSignal, call: (client: Client) => Promise<Result>): Promise<Result> {
    try {
      return await call(await connectE2BSandbox(env, sandboxId, signal));
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
