/**
 * Path: server/src/git/clone.ts
 * Used by: server/src/git/tools.ts, server/src/sessions/thread.ts.
 * Purpose: Builds the sandbox script that clones a registered repo and sets its Git identity, and registers and starts the repo requested at session creation.
 */

import type { GitIdentity } from '@cloud-swe/protocol/credentials';
import { defaultRepoPath, type InitialRepo } from '@cloud-swe/protocol/git';
import type { z } from 'zod';

import { credentialsStub } from '../env.ts';
import { type ToolHost, toolWorkspace } from '../sandbox/host.ts';
import { dispatchRemoteCommand, sandboxRoot } from '../sandbox/remote.ts';
import { quote } from '../sandbox/runner.ts';
import type { KvReader, KvWriter } from '../storage.ts';
import { gitConfigPath, refreshGitAccess } from './access.ts';
import { registerRepo } from './repos.ts';

type CloneInput = {
  url: string;
  path: string;
  branch?: string;
  configPath: string;
  identity?: GitIdentity;
};

/**
 * Everything is single-quoted and inputs are already validated by the protocol schemas. The global include makes
 * every later `git fetch` and `git push` in the sandbox use the session's proxy for github.com.
 * Cloning is skipped when the checkout exists, so a replay or a retry is harmless.
 */
export function cloneScript(input: CloneInput): string {
  const path = quote(input.path);

  return [
    'set -e',
    `git config --global --replace-all include.path ${quote(input.configPath)}`,
    `if [ ! -d ${path}/.git ]; then`,
    `  GIT_TERMINAL_PROMPT=0 git clone${input.branch ? ' --branch ' + quote(input.branch) : ''} -- ${quote(input.url)} ${path}`,
    'fi',
    ...(input.identity
      ? [
          `git -C ${path} config user.name ${quote(input.identity.name)}`,
          `git -C ${path} config user.email ${quote(input.identity.email)}`,
        ]
      : []),
  ].join('\n');
}

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
    const root = await sandboxRoot(host.env, workspace);
    const identity = await credentialsStub(host.env).githubIdentity();

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
