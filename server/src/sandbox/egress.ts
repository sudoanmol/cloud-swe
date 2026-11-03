/**
 * Path: server/src/sandbox/egress.ts
 * Used by: server/src/sandbox/commands.ts.
 * Purpose: Brings the sandbox in line with the session's environment before each fresh agent command: the env file the supervisor reads. Makes no sandbox call when nothing changed.
 */

import type { WorkspaceRecord } from '@cloud-swe/protocol/storage';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import { z } from 'zod';

import { credentialsStub } from '../env.ts';
import { readParsed } from '../storage.ts';
import { requireSession } from '../thread-store.ts';
import type { ToolHost } from './host.ts';
import { runRemoteCommand, sandboxRoot, writeRemoteFile } from './remote.ts';
import { quote } from './runner.ts';

const KEY = 'sandboxSync';

// What was last applied to which sandbox. A replaced sandbox has another workspace ID, so it is synced afresh.
const SandboxSync = z.strictObject({
  workspaceId: z.uuid(),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  root: z.string(),
});

const ENV_FILE = '.cloud-swe/env.json';

const sorted = (values: Record<string, string>) =>
  Object.fromEntries(Object.entries(values).toSorted(([a], [b]) => a.localeCompare(b)));

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The env file the session's environment asks for, and its hash. */
async function desired(host: ToolHost) {
  const { environment } = await requireSession(host.storage);
  const view = environment ? await credentialsStub(host.env).sandboxView(environment) : undefined;
  const envFile = sorted({ ...view?.variables, ...view?.placeholders });

  return { envFile, empty: Object.keys(envFile).length === 0, hash: await sha256(JSON.stringify(envFile)) };
}

/** Writes the next env file, then moves it into place in one command, so a starting command never reads half of it. */
async function apply(host: ToolHost, workspace: WorkspaceRecord, root: string, envFile: Record<string, string>) {
  const path = `${root}/${ENV_FILE}`;

  await writeRemoteFile(host.env, workspace, path + '.next', JSON.stringify(envFile), AbortSignal.timeout(10_000));

  const { stdout } = await runRemoteCommand(
    host.env,
    workspace,
    `chmod 600 ${quote(path + '.next')} && mv -f ${quote(path + '.next')} ${quote(path)} && echo applied`,
    undefined,
    30_000,
  );

  return stdout.trim().endsWith('applied');
}

async function syncOnce(host: ToolHost, workspace: WorkspaceRecord, api: ToolExecutionApi) {
  const stored = await readParsed(host.storage, KEY, SandboxSync);
  const known = stored?.workspaceId === workspace.id ? stored : undefined;
  const envPath = (root: string) => `${root}/${ENV_FILE}`;

  try {
    const next = await desired(host);

    // A sandbox that never had an environment needs no empty file.
    if (known ? next.hash === known.hash : next.empty) return known && envPath(known.root);
    const root = known?.root ?? (await sandboxRoot(host.env, workspace)).replace(/\/$/, '');

    if (await apply(host, workspace, root, next.envFile)) {
      await host.storage.put(KEY, SandboxSync.parse({ workspaceId: workspace.id, hash: next.hash, root }));
    } else stale(api);

    return envPath(root);
  } catch {
    stale(api);

    return known && envPath(known.root);
  }
}

// Normal work never waits on this: the command runs anyway, and the next fresh command tries again.
function stale(api: ToolExecutionApi) {
  api.diagnostic({
    severity: 'warn',
    code: 'environment_stale',
    message: "The session's environment could not be applied; this command may see older values",
  });
}

// Parallel commands in one session apply one change once: each waits for the one before, then finds it applied.
const syncing = new Map<string, Promise<unknown>>();

/** Run just before a fresh command's dispatch. Returns the env file path for its supervisor, if the sandbox has one. */
export function syncSandbox(
  host: ToolHost,
  workspace: WorkspaceRecord,
  api: ToolExecutionApi,
): Promise<string | undefined> {
  const task = (syncing.get(workspace.id) ?? Promise.resolve()).then(() => syncOnce(host, workspace, api));
  const tail = task.catch(() => undefined);
  syncing.set(workspace.id, tail);
  void tail.then(() => syncing.get(workspace.id) === tail && syncing.delete(workspace.id));

  return task;
}
