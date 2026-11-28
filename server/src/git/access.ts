/**
 * Path: server/src/git/access.ts
 * Used by: server/src/git/clone.ts, server/src/sessions/{keep-alive,thread}.ts.
 * Purpose: The per-session Git capability: a random token stored only as a SHA-256 hash with a 1 h expiry, the sandbox git config that carries it, and whether a token is valid.
 */

import { GIT_TOKEN_LIMIT, GitAccess, type WorkspaceRecord } from '@cloud-swe/protocol/storage';

import { publicUrl } from '../env.ts';
import { randomToken, sha256 } from '../ids.ts';
import { type ToolHost, toolWorkspace } from '../sandbox/host.ts';
import { platformPath, readRemoteFile, sandboxRoot, writeRemoteFile } from '../sandbox/remote.ts';
import { type KvReader, type KvWriter, readParsed } from '../storage.ts';
import { readRepos } from './repos.ts';

const TTL_MS = 60 * 60 * 1000;

const REFRESH_MARGIN_MS = 20 * 60 * 1000;

const KEY = 'gitAccess';

export async function readAccess(storage: KvReader) {
  return readParsed(storage, KEY, GitAccess);
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

export async function tokenValid(storage: KvReader, token: string): Promise<boolean> {
  const access = await readAccess(storage);

  if (!access) return false;
  const hash = await sha256(token);

  return access.tokens.some((known) => known.expiresAt > Date.now() && known.hash === hash);
}

/** The remote helper a GitHub checkout names in `remote.origin.vcs`; `cloud-swe::<url>` uses it for a bare URL. */
export const GIT_HELPER = 'cloud-swe';

/**
 * The sandbox-side config: a remote helper, written as an alias so it needs no program installed, that sends a
 * remote's requests to this session's proxy, and the capability token for the proxy. A `url.insteadOf` rewrite would do
 * the same for Git, but `git remote -v` prints the rewritten URL, and `gh` then finds no GitHub remote.
 */
export function gitConfig(baseUrl: string, sessionId: string, token: string): string {
  const proxy = `${baseUrl}/git/${sessionId}/`;

  return [
    '[alias]',
    `\tremote-${GIT_HELPER} = "!f() { exec git remote-https \\"$1\\" \\"${proxy}\${2#https://}\\"; }; f"`,
    `[http "${proxy}"]`,
    `\textraHeader = Authorization: Bearer ${token}`,
    '',
  ].join('\n');
}

const gitConfigPath = (root: string) => platformPath(root, 'git.config');

/** Mints a new token, writes the sandbox git config that carries it and stores only the token's hash. */
async function rotate(host: ToolHost, workspace: WorkspaceRecord, root: string): Promise<void> {
  const url = publicUrl(host.env);

  if (!url) throw new Error('PUBLIC_URL is not configured');
  const token = randomToken();

  await writeRemoteFile(
    host.env,
    workspace,
    gitConfigPath(root),
    gitConfig(url, workspace.sessionId, token),
    AbortSignal.timeout(10_000),
  );

  await storeToken(host.storage, token);
}

/**
 * Before a clone: rotates only when the stored token is close to expiry or the sandbox has no config file, which a
 * replaced sandbox does not. Rotating on every clone would churn tokens for nothing. Returns the config file's path.
 */
export async function ensureGitAccess(host: ToolHost, workspace: WorkspaceRecord, root: string): Promise<string> {
  const current =
    !(await tokenExpiring(host.storage)) &&
    (await readRemoteFile(host.env, workspace, gitConfigPath(root), AbortSignal.timeout(5000)).then(
      () => true,
      () => false,
    ));

  if (!current) await rotate(host, workspace, root);

  return gitConfigPath(root);
}

/**
 * At message admission and from the keep-alive during a run: rotates only with repos and a token near expiry. A sandbox
 * outage must not block messages.
 */
export async function refreshGitAccessIfNeeded(host: ToolHost): Promise<void> {
  if (!publicUrl(host.env) || (await readRepos(host.storage)).length === 0 || !(await tokenExpiring(host.storage)))
    return;

  try {
    const workspace = await toolWorkspace(host);
    await rotate(host, workspace, await sandboxRoot(host.env, workspace));
  } catch {
    // Retried at the next admission or keep-alive tick.
  }
}
