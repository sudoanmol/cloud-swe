/**
 * Path: server/src/git/initial-repo.ts
 * Used by: server/src/sessions/thread.ts.
 * Purpose: Registers the repo requested at session creation as the base, in the same write as the session, and starts its clone in the sandbox.
 */
import { defaultRepoPath, type InitialRepo } from '@cloud-swe/protocol/git';
import type { z } from 'zod';

import { type ToolHost, toolWorkspace } from '../tools/host.ts';
import { dispatchRemoteCommand, remoteFileInfo } from '../tools/remote.ts';
import { quote } from '../tools/runner.ts';
import { gitConfigPath, refreshGitAccess } from './access.ts';
import { cloneScript } from './clone.ts';
import type { KvReader, KvWriter } from './kv.ts';
import { registerRepo } from './repos.ts';

type Repo = z.output<typeof InitialRepo>;

function directory(repo: Repo): string {
  const path = defaultRepoPath(repo.url);

  // The creation request schema already refuses a repository without a usable directory.
  if (path === undefined) throw new Error('Repository has no usable directory name');

  return path;
}

/** Registration is durable and decides authorization, so it joins the transaction that writes the session. */
export async function registerInitialRepo(storage: KvReader & KvWriter, repo: Repo): Promise<void> {
  await registerRepo(storage, repo.url, directory(repo), true);
}

/**
 * The clone is a detached, unreconciled command, because no Pi task exists yet: if it does not finish, the
 * agent's git_clone is idempotent and completes it.
 */
export async function startInitialClone(host: ToolHost, repo: Repo): Promise<void> {
  try {
    await refreshGitAccess(host);
    const workspace = await toolWorkspace(host);
    const root = (await remoteFileInfo(host.env, workspace, '.', AbortSignal.timeout(5000))).path;
    const identity = await host.env.CREDENTIALS.get(host.env.CREDENTIALS.idFromName('personal')).githubIdentity();

    const script = cloneScript({
      url: repo.url,
      path: directory(repo),
      branch: repo.branch,
      configPath: await gitConfigPath(host),
      identity,
    });

    await dispatchRemoteCommand(host.env, workspace, `cd ${quote(root)}\n${script}`, AbortSignal.timeout(10_000));
  } catch {
    // The repo stays registered; the agent can clone it with git_clone.
  }
}
