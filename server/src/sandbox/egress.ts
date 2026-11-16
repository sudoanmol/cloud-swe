/**
 * Path: server/src/sandbox/egress.ts
 * Used by: server/src/auth.ts, server/src/sandbox/commands.ts, server/src/sessions/{keep-alive,thread}.ts.
 * Purpose: Brings the sandbox in line with the session's environment before each fresh agent command (the env file the supervisor reads, and the egress daemon's config), rotates the network capability token as the Git token is rotated, and decides whether a token may use the proxy. Makes no sandbox call when nothing changed.
 */

import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';

import type { WorkspaceRecord } from '@cloud-swe/protocol/storage';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import { z } from 'zod';

import { catalogStub, credentialsStub, type Env, publicUrl } from '../env.ts';
import { randomToken, sha256 } from '../ids.ts';
import { quote } from '../shell.ts';
import { type KvReader, type KvWriter, readParsed } from '../storage.ts';
import { requireSession } from '../thread-store.ts';
import {
  EGRESS_DAEMON,
  EGRESS_PATHS,
  type EgressConfig,
  SETUP_SCRIPT,
  SETUP_VERSION,
  TRUST_ENV,
} from './egress-daemon.ts';
import { type ToolHost, toolWorkspace } from './host.ts';
import { platformPath, runRemoteCommand, sandboxRoot, writeRemoteFile } from './remote.ts';

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

// The capability the daemon sends to /net, bound to one sandbox; replacing it revokes them all. Rotated like the Git
// token (git/access.ts): 1 h each, a new one once the newest is within 20 min of expiry, and every older unexpired one
// stays valid, newest last. The daemon reads the token per request, so only requests already in flight hold an old one.
// Stored as is, unlike the Git token's hash: the daemon config is rewritten whenever the environment changes.
const NetworkAccess = z.strictObject({
  workspaceId: z.uuid(),
  tokens: z.array(z.strictObject({ token: Hash, expiresAt: z.number() })).min(1),
});

type NetworkAccess = z.infer<typeof NetworkAccess>;

const TTL_MS = 60 * 60 * 1000;

const REFRESH_MARGIN_MS = 20 * 60 * 1000;

const envFilePath = (root: string) => platformPath(root, 'env.json');

const sorted = (values: Record<string, string>) =>
  Object.fromEntries(Object.entries(values).toSorted(([a], [b]) => a.localeCompare(b)));

// A regenerable capability: an unreadable row, such as one from before rotation, counts as none and is replaced.
async function readAccess(storage: KvReader): Promise<NetworkAccess | undefined> {
  return NetworkAccess.safeParse(await storage.get(ACCESS_KEY)).data;
}

const expiring = (access: NetworkAccess) => (access.tokens.at(-1)?.expiresAt ?? 0) - Date.now() < REFRESH_MARGIN_MS;

/** The token the daemon config should carry: the newest, or a new one once it nears expiry. */
async function networkToken(storage: KvReader & KvWriter, workspaceId: string): Promise<string> {
  const stored = await readAccess(storage);
  const own = stored?.workspaceId === workspaceId ? stored : undefined;
  const newest = own?.tokens.at(-1);

  if (own && newest && !expiring(own)) return newest.token;
  const token = randomToken();
  const unexpired = (own?.tokens ?? []).filter((known) => known.expiresAt > Date.now());
  const tokens = [...unexpired, { token, expiresAt: Date.now() + TTL_MS }];
  await storage.put(ACCESS_KEY, NetworkAccess.parse({ workspaceId, tokens }));

  return token;
}

type Next = { envFile: Record<string, string>; egress: Omit<EgressConfig, 'hash'> | undefined; hash: string };

/** What the session's environment asks the sandbox to hold. No network-secret value is in it. */
async function desired(host: ToolHost, workspace: WorkspaceRecord, known: SandboxSync | undefined): Promise<Next> {
  const session = await requireSession(host.storage);
  const view = session.environment ? await credentialsStub(host.env).sandboxView(session.environment) : undefined;
  const workerUrl = publicUrl(host.env);
  const hosts = workerUrl ? (view?.hosts ?? []) : [];
  // Once the daemon is installed it stays configured, so removing the last network secret clears /etc/hosts too.
  const egressOn = workerUrl !== undefined && (hosts.length > 0 || known?.setupVersion !== undefined);
  const envFile = sorted({ ...view?.variables, ...view?.placeholders, ...(egressOn ? TRUST_ENV : undefined) });

  // Key order is part of the hash that synced sandboxes are stored with.
  const egress = egressOn
    ? { workerUrl, sessionId: session.id, token: await networkToken(host.storage, workspace.id), hosts }
    : undefined;

  return {
    envFile,
    egress,
    hash: await sha256(SETUP_VERSION + JSON.stringify(envFile) + JSON.stringify(egress ?? null)),
  };
}

const write = (host: ToolHost, workspace: WorkspaceRecord, path: string, content: string, user?: 'root') =>
  writeRemoteFile(host.env, workspace, path, content, AbortSignal.timeout(10_000), user);

/**
 * Two file writes and one command: the next files go in through the files API (E2B doesn't log it), then one command
 * whose text holds only paths and hashes moves them into place. With egress it runs as root, installs or updates the
 * daemon when its version differs, and waits for the daemon to acknowledge the new config.
 */
async function apply(host: ToolHost, workspace: WorkspaceRecord, root: string, next: Next, setUp: boolean) {
  const envPath = envFilePath(root);
  await write(host, workspace, envPath + '.next', JSON.stringify(next.envFile));
  const moveEnv = `chmod 600 ${quote(envPath + '.next')} && mv -f ${quote(envPath + '.next')} ${quote(envPath)}`;

  let script = `${moveEnv} && echo applied`;
  let user: 'root' | undefined;

  if (next.egress) {
    const { config, nextDaemon, setup, setupVersion, applied } = EGRESS_PATHS;

    if (setUp) {
      await write(host, workspace, nextDaemon, EGRESS_DAEMON, 'root');
      await write(host, workspace, setup, SETUP_SCRIPT, 'root');
    }

    const daemonConfig: EgressConfig = { ...next.egress, hash: next.hash };
    await write(host, workspace, config + '.next', JSON.stringify(daemonConfig), 'root');

    user = 'root';
    script = [
      'set -eu',
      `if [ "$(cat ${setupVersion} 2>/dev/null || true)" != ${SETUP_VERSION} ]; then bash ${setup} ${SETUP_VERSION}; fi`,
      `chmod 600 ${config}.next && mv -f ${config}.next ${config}`,
      moveEnv,
      `for i in $(seq 1 50); do [ "$(cat ${applied} 2>/dev/null || true)" = ${next.hash} ] && { echo applied; exit 0; }; sleep 0.1; done`,
      'echo stale',
    ].join('\n');
  }

  const { stdout } = await runRemoteCommand(host.env, workspace, script, user, 30_000);

  return stdout.trim().endsWith('applied');
}

async function syncOnce(host: ToolHost, workspace: WorkspaceRecord, api: ToolExecutionApi | undefined) {
  const stored = await readParsed(host.storage, SYNC_KEY, SandboxSync);
  const known = stored?.workspaceId === workspace.id ? stored : undefined;

  try {
    const next = await desired(host, workspace, known);

    // A sandbox that never had an environment needs no empty file.
    if (known ? next.hash === known.hash : Object.keys(next.envFile).length === 0 && !next.egress)
      return known && envFilePath(known.root);
    const root = known?.root ?? (await sandboxRoot(host.env, workspace));

    if (await apply(host, workspace, root, next, known?.setupVersion !== SETUP_VERSION)) {
      const setupVersion = next.egress ? SETUP_VERSION : known?.setupVersion;
      const sync = SandboxSync.parse({ workspaceId: workspace.id, hash: next.hash, root, setupVersion });
      await host.storage.put(SYNC_KEY, sync);
    } else stale(api);

    return envFilePath(root);
  } catch {
    stale(api);

    return known && envFilePath(known.root);
  }
}

// Normal work never waits on this: the command runs anyway, and the next fresh command tries again.
function stale(api: ToolExecutionApi | undefined) {
  api?.diagnostic({
    severity: 'warn',
    code: 'environment_stale',
    message: "The session's environment could not be applied; this command may see older values",
  });
}

// Parallel commands in one session apply one change once: each waits for the one before, then finds it applied.
const syncing = new Map<string, Promise<unknown>>();

/**
 * Run just before a fresh command's dispatch, with its `api` for warnings. Returns the env file path for its supervisor,
 * if the sandbox has one.
 */
export function syncSandbox(
  host: ToolHost,
  workspace: WorkspaceRecord,
  api?: ToolExecutionApi,
): Promise<string | undefined> {
  const task = (syncing.get(workspace.id) ?? Promise.resolve()).then(() => syncOnce(host, workspace, api));
  const tail = task.catch(() => undefined);
  syncing.set(workspace.id, tail);
  void tail.then(() => syncing.get(workspace.id) === tail && syncing.delete(workspace.id));

  return task;
}

/**
 * From each keep-alive tick, as the Git token is refreshed: a token near expiry is rotated into the daemon config even
 * when no command starts, so a long-running command, or a process that was paused across a rotation and resumed with
 * the sandbox, keeps a live one. A resume only follows a message, whose admission arms the first tick at once. A
 * failure is retried next tick, and every fresh command syncs first anyway.
 */
export async function refreshNetworkAccessIfNeeded(host: ToolHost): Promise<void> {
  const access = await readAccess(host.storage);
  const session = await requireSession(host.storage);

  if (!access || access.workspaceId !== session.workspace.id || !expiring(access)) return;

  try {
    await syncSandbox(host, await toolWorkspace(host));
  } catch {
    // A stopped sandbox has no binding; the next tick or command tries again.
  }
}

/** Compares two secrets in constant time. */
export function sameSecret(given: string, expected: string): boolean {
  const [a, b] = [Buffer.from(given), Buffer.from(expected)];

  return a.length === b.length && timingSafeEqual(a, b);
}

type NetworkAuthorization =
  | { ok: true; environment: string | null }
  | { ok: false; reason: 'unauthorized' | 'unavailable' };

/**
 * Whether `token` is an unexpired capability for this session's current sandbox, and that sandbox is running: a token
 * copied out of the sandbox is refused while it is paused. The catalog's cached state is trusted only when it says
 * running, so a cached `running` can outlive a pause by up to its 15 s cache; any other cached state is inspected
 * afresh, so a call just after a resume passes. An inspection reads the provider's API and never wakes a sandbox.
 * A sandbox still starting, or a provider that can't be read, is `unavailable` (retryable), never allowed.
 */
export async function networkAuthorization(
  host: { env: Pick<Env, 'CATALOG'>; storage: Pick<DurableObjectStorage, 'get'> },
  token: string,
): Promise<NetworkAuthorization> {
  const access = await readAccess(host.storage);
  const now = Date.now();

  if (!access?.tokens.some((known) => known.expiresAt > now && sameSecret(token, known.token)))
    return { ok: false, reason: 'unauthorized' };

  const session = await requireSession(host.storage);

  if (session.workspace.id !== access.workspaceId) return { ok: false, reason: 'unauthorized' };

  const catalog = catalogStub(host.env);

  const state = await catalog
    .workspaceState(session.id, access.workspaceId)
    .then((cached) =>
      cached === 'running' || cached === 'deleted'
        ? cached
        : catalog.workspaceState(session.id, access.workspaceId, true),
    )
    .catch(() => 'unreachable' as const);

  if (state === 'running') return { ok: true, environment: session.environment };

  return { ok: false, reason: state === 'deleted' || state === 'stopped' ? 'unauthorized' : 'unavailable' };
}
