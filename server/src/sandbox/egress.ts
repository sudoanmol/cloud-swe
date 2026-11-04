/**
 * Path: server/src/sandbox/egress.ts
 * Used by: server/src/sandbox/commands.ts, server/src/sessions/thread.ts.
 * Purpose: Brings the sandbox in line with the session's environment before each fresh agent command (the env file the supervisor reads, and the egress daemon's config), and decides whether a network capability token may use the proxy. Makes no sandbox call when nothing changed.
 */

import type { WorkspaceRecord } from '@cloud-swe/protocol/storage';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import { z } from 'zod';

import { catalogStub, credentialsStub, type Env } from '../env.ts';
import { type KvReader, type KvWriter, readParsed } from '../storage.ts';
import { requireSession } from '../thread-store.ts';
import { EGRESS_DAEMON, EGRESS_PATHS, SETUP_SCRIPT, SETUP_VERSION, TRUST_ENV } from './egress-daemon.ts';
import type { ToolHost } from './host.ts';
import { runRemoteCommand, sandboxRoot, writeRemoteFile } from './remote.ts';
import { quote } from './runner.ts';

const SYNC_KEY = 'sandboxSync';

const ACCESS_KEY = 'netAccess';

const Hash = z.string().regex(/^[0-9a-f]{64}$/);

// What was last applied to which sandbox. A replaced sandbox has another workspace ID, so it is synced afresh.
// `setupVersion` is set once the egress daemon is installed there.
const SandboxSync = z.strictObject({
  workspaceId: z.uuid(),
  hash: Hash,
  root: z.string(),
  setupVersion: z.string().optional(),
});

type SandboxSync = z.infer<typeof SandboxSync>;

// The capability the daemon sends to /net. Bound to one sandbox and kept for its life, since long-running processes
// hold connections; replacing or deleting the sandbox revokes it.
const NetworkAccess = z.strictObject({ workspaceId: z.uuid(), token: Hash });

const ENV_FILE = '.cloud-swe/env.json';

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

const sorted = (values: Record<string, string>) =>
  Object.fromEntries(Object.entries(values).toSorted(([a], [b]) => a.localeCompare(b)));

async function sha256(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

async function networkToken(storage: KvReader & KvWriter, workspaceId: string): Promise<string> {
  const stored = await readParsed(storage, ACCESS_KEY, NetworkAccess);

  if (stored?.workspaceId === workspaceId) return stored.token;
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await storage.put(ACCESS_KEY, NetworkAccess.parse({ workspaceId, token }));

  return token;
}

/** What the session's environment asks the sandbox to hold, and its hash. No network-secret value is in it. */
async function desired(host: ToolHost, workspace: WorkspaceRecord, known: SandboxSync | undefined) {
  const session = await requireSession(host.storage);
  const view = session.environment ? await credentialsStub(host.env).sandboxView(session.environment) : undefined;
  const workerUrl = host.env.PUBLIC_URL?.replace(/\/$/, '');
  const hosts = workerUrl ? (view?.hosts ?? []) : [];
  // Once the daemon is installed it stays configured, so removing the last network secret clears /etc/hosts too.
  const egressOn = workerUrl !== undefined && (hosts.length > 0 || known?.setupVersion !== undefined);
  const envFile = sorted({ ...view?.variables, ...view?.placeholders, ...(egressOn ? TRUST_ENV : undefined) });

  const egress = egressOn
    ? { workerUrl, sessionId: session.id, token: await networkToken(host.storage, workspace.id), hosts }
    : undefined;

  const hash = await sha256(SETUP_VERSION + JSON.stringify(envFile) + JSON.stringify(egress ?? null));

  return { envFile, egress, hash, empty: Object.keys(envFile).length === 0 && !egress };
}

type Desired = Awaited<ReturnType<typeof desired>>;

const write = (host: ToolHost, workspace: WorkspaceRecord, path: string, content: string, user?: 'root') =>
  writeRemoteFile(host.env, workspace, path, content, AbortSignal.timeout(10_000), user);

/**
 * Two file writes and one command: the next files go in through the files API (E2B doesn't log it), then one command
 * whose text holds only paths and hashes moves them into place. With egress it runs as root, installs or updates the
 * daemon when its version differs, and waits for the daemon to acknowledge the new config.
 */
async function apply(host: ToolHost, workspace: WorkspaceRecord, root: string, next: Desired, setUp: boolean) {
  const envPath = `${root}/${ENV_FILE}`;
  await write(host, workspace, envPath + '.next', JSON.stringify(next.envFile));
  const moveEnv = `chmod 600 ${quote(envPath + '.next')} && mv -f ${quote(envPath + '.next')} ${quote(envPath)}`;

  if (!next.egress) {
    const { stdout } = await runRemoteCommand(host.env, workspace, `${moveEnv} && echo applied`, undefined, 30_000);

    return stdout.trim().endsWith('applied');
  }

  const { dir, config, setup, applied } = EGRESS_PATHS;

  if (setUp) {
    await write(host, workspace, `${dir}/egress.mjs.next`, EGRESS_DAEMON, 'root');
    await write(host, workspace, setup, SETUP_SCRIPT, 'root');
  }

  await write(host, workspace, config + '.next', JSON.stringify({ ...next.egress, hash: next.hash }), 'root');

  const script = [
    'set -eu',
    `if [ "$(cat ${dir}/setup-version 2>/dev/null || true)" != ${SETUP_VERSION} ]; then bash ${setup} ${SETUP_VERSION}; fi`,
    `chmod 600 ${config}.next && mv -f ${config}.next ${config}`,
    moveEnv,
    `for i in $(seq 1 50); do [ "$(cat ${applied} 2>/dev/null || true)" = ${next.hash} ] && { echo applied; exit 0; }; sleep 0.1; done`,
    'echo stale',
  ].join('\n');

  const { stdout } = await runRemoteCommand(host.env, workspace, script, 'root', 30_000);

  return stdout.trim().endsWith('applied');
}

async function syncOnce(host: ToolHost, workspace: WorkspaceRecord, api: ToolExecutionApi) {
  const stored = await readParsed(host.storage, SYNC_KEY, SandboxSync);
  const known = stored?.workspaceId === workspace.id ? stored : undefined;
  const envPath = (root: string) => `${root}/${ENV_FILE}`;

  try {
    const next = await desired(host, workspace, known);

    // A sandbox that never had an environment needs no empty file.
    if (known ? next.hash === known.hash : next.empty) return known && envPath(known.root);
    const root = known?.root ?? (await sandboxRoot(host.env, workspace)).replace(/\/$/, '');

    if (await apply(host, workspace, root, next, known?.setupVersion !== SETUP_VERSION)) {
      const setupVersion = next.egress ? SETUP_VERSION : known?.setupVersion;
      const sync = SandboxSync.parse({ workspaceId: workspace.id, hash: next.hash, root, setupVersion });
      await host.storage.put(SYNC_KEY, sync);
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

/** Compares in time that doesn't depend on where the strings differ. */
function sameSecret(given: string, expected: string): boolean {
  let difference = given.length ^ expected.length;

  for (let index = 0; index < expected.length; index++) {
    difference |= (given.charCodeAt(index) || 0) ^ expected.charCodeAt(index);
  }

  return difference === 0;
}

export type NetworkAuthorization =
  | { ok: true; environment: string | null }
  | { ok: false; reason: 'unauthorized' | 'unavailable' };

/**
 * Whether `token` is this session's capability for its current, live sandbox. Reads stored state and the catalog's
 * cached workspace state only, so it never wakes a paused sandbox.
 */
export async function networkAuthorization(
  host: { env: Pick<Env, 'CATALOG'>; storage: Pick<DurableObjectStorage, 'get'> },
  token: string,
): Promise<NetworkAuthorization> {
  const access = await readParsed(host.storage, ACCESS_KEY, NetworkAccess);

  if (!access || !sameSecret(token, access.token)) return { ok: false, reason: 'unauthorized' };

  const session = await requireSession(host.storage);

  if (session.workspace.id !== access.workspaceId) return { ok: false, reason: 'unauthorized' };

  try {
    const state = await catalogStub(host.env).workspaceState(session.id, access.workspaceId);

    if (state === 'deleted') return { ok: false, reason: 'unauthorized' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }

  return { ok: true, environment: session.environment };
}
