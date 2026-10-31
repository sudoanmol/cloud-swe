import { GIT_TOKEN_LIMIT, GitAccess } from '@cloud-swe/protocol/storage';

import { type ToolHost, toolWorkspace } from '../tools/host.ts';
import { readRemoteFile, remoteFileInfo, writeRemoteFile } from '../tools/remote.ts';
import type { KvReader, KvWriter } from './kv.ts';
import { isRegisteredGitHub, readRepos } from './repos.ts';

const TTL_MS = 60 * 60 * 1000;

const REFRESH_MARGIN_MS = 20 * 60 * 1000;

const KEY = 'gitAccess';

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

async function sha256(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

export const newToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));

async function readAccess(storage: KvReader) {
  const raw = await storage.get<unknown>(KEY);

  return raw === undefined ? undefined : GitAccess.parse(raw);
}

/**
 * Rotates the session's capability. Every older token lasts until its own expiry, for Git commands already running
 * (a clone can outlive several rotations); only the newest GIT_TOKEN_LIMIT are kept.
 */
export async function storeToken(storage: KvReader & KvWriter, token: string): Promise<void> {
  const unexpired = ((await readAccess(storage))?.tokens ?? []).filter((known) => known.expiresAt > Date.now());
  const tokens = [...unexpired, { hash: await sha256(token), expiresAt: Date.now() + TTL_MS }].slice(-GIT_TOKEN_LIMIT);

  await storage.put(KEY, GitAccess.parse({ tokens }));
}

/** Whether the newest token is missing or close enough to expiry that a long Git command could outlive it. */
export async function tokenExpiring(storage: KvReader): Promise<boolean> {
  const newest = (await readAccess(storage))?.tokens.at(-1);

  return !newest || newest.expiresAt - Date.now() < REFRESH_MARGIN_MS;
}

/** Whether `token` is one of this session's unexpired capabilities. */
export async function tokenValid(storage: KvReader, token: string): Promise<boolean> {
  const access = await readAccess(storage);

  if (!access) return false;
  const hash = await sha256(token);

  return access.tokens.some((known) => known.expiresAt > Date.now() && known.hash === hash);
}

/** The sandbox-side config: rewrite github.com to this session's proxy and send the capability token to it. */
export function gitConfig(publicUrl: string, sessionId: string, token: string): string {
  const proxy = `${publicUrl}/git/${sessionId}/`;

  return [
    `[url "${proxy}github.com/"]`,
    '\tinsteadOf = https://github.com/',
    `[http "${proxy}"]`,
    `\textraHeader = Authorization: Bearer ${token}`,
    '',
  ].join('\n');
}

export type GitAuthorization = 'ok' | 'unauthorized' | 'forbidden';

export async function gitAuthorization(
  storage: KvReader,
  token: string,
  owner: string,
  repo: string,
): Promise<GitAuthorization> {
  if (!(await tokenValid(storage, token))) return 'unauthorized';

  return (await isRegisteredGitHub(storage, owner.toLowerCase(), repo.toLowerCase())) ? 'ok' : 'forbidden';
}

const GIT_CONFIG_PATH = '.cloud-swe/git.config';

/** Absolute path of the config file inside the sandbox. */
export async function gitConfigPath(host: ToolHost): Promise<string> {
  const workspace = await toolWorkspace(host);
  const root = await remoteFileInfo(host.env, workspace, '.', AbortSignal.timeout(5000));

  return root.path.replace(/\/$/, '') + '/' + GIT_CONFIG_PATH;
}

/**
 * Mints a new token (replacing the old one), writes the sandbox git config and stores only the token's hash.
 * Call before any clone and at message admission; a keep-alive may call it while a run is active.
 */
export async function refreshGitAccess(host: ToolHost): Promise<void> {
  const publicUrl = host.env.PUBLIC_URL;

  if (!publicUrl) throw new Error('PUBLIC_URL is not configured');
  const workspace = await toolWorkspace(host);
  const token = newToken();

  await writeRemoteFile(
    host.env,
    workspace,
    await gitConfigPath(host),
    gitConfig(publicUrl.replace(/\/$/, ''), workspace.sessionId, token),
    AbortSignal.timeout(10_000),
  );

  await storeToken(host.storage, token);
}

/**
 * For git_clone: rotates only when the stored token is close to expiry or the sandbox has no config file, which a
 * replaced sandbox does not. Rotating on every clone would churn tokens for nothing.
 */
export async function ensureGitAccess(host: ToolHost): Promise<void> {
  const configured = await readRemoteFile(
    host.env,
    await toolWorkspace(host),
    await gitConfigPath(host),
    AbortSignal.timeout(5000),
  ).then(
    () => true,
    () => false,
  );

  if (!configured || (await tokenExpiring(host.storage))) await refreshGitAccess(host);
}

/** Admission and keep-alive refresh, only with repos and a token near expiry. A sandbox outage must not block messages. */
export async function refreshGitAccessIfNeeded(host: ToolHost): Promise<void> {
  if ((await readRepos(host.storage)).length === 0 || !(await tokenExpiring(host.storage))) return;

  await refreshGitAccess(host).catch(() => undefined);
}
