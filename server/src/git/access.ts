/**
 * Path: server/src/git/access.ts
 * Used by: server/src/git/{repo-tools,initial-repo}.ts, server/src/sessions/thread.ts.
 * Purpose: Mints the session's Git capability token and writes the sandbox git config that carries it. Export for any keep-alive: refreshGitAccess(host).
 */
import { type ToolHost, toolWorkspace } from '../tools/host';
import { remoteFileInfo, writeRemoteFile } from '../tools/remote';
import { gitConfig, newToken, storeToken, tokenExpiring } from './capability';
import { readRepos } from './repos';

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

/** Admission and keep-alive refresh, only with repos and a token near expiry. A sandbox outage must not block messages. */
export async function refreshGitAccessIfNeeded(host: ToolHost): Promise<void> {
  if ((await readRepos(host.storage)).length === 0 || !(await tokenExpiring(host.storage))) return;

  await refreshGitAccess(host).catch(() => undefined);
}
