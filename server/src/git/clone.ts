/**
 * Path: server/src/git/clone.ts
 * Used by: server/src/git/tools.ts, server/src/sessions/thread.ts.
 * Purpose: Builds the sandbox script that clones a registered repo, makes the app's bot the commit author and credits the signed-in account as co-author, prepares Git access for it, and registers and starts the repo requested at session creation.
 */

import type { GitIdentity } from '@cloud-swe/protocol/credentials';
import { defaultRepoPath, type InitialRepo } from '@cloud-swe/protocol/git';
import type { WorkspaceRecord } from '@cloud-swe/protocol/storage';
import type { z } from 'zod';

import { credentialsStub } from '../env.ts';
import { type ToolHost, toolWorkspace } from '../sandbox/host.ts';
import { dispatchRemoteCommand, sandboxRoot } from '../sandbox/remote.ts';
import { quote } from '../shell.ts';
import type { KvReader, KvWriter } from '../storage.ts';
import { ensureGitAccess } from './access.ts';
import { registerRepo } from './repos.ts';

/** GitHub links commits to the app's bot through this address; the number is the bot account's user ID. */
const BOT_NAME = 'cloud-swe[bot]';
const BOT_EMAIL = '332717987+cloud-swe[bot]@users.noreply.github.com';

type CloneTarget = { url: string; path: string; branch?: string };

function coAuthorHook(identity: GitIdentity): string {
  const trailer = `Co-authored-by: ${identity.name} <${identity.email}>`;

  return `#!/bin/sh\nexec git interpret-trailers --in-place --if-exists addIfDifferent --trailer ${quote(trailer)} "$1"`;
}

/**
 * Everything is single-quoted and inputs are already validated by the protocol schemas. The global include makes
 * every later `git fetch` and `git push` in the sandbox use the session's proxy for github.com.
 * Cloning is skipped when the checkout exists, so a replay or a retry is harmless; a clone that is still running or was
 * killed leaves no checkout.
 * The hook keeps the co-author credit on every commit, whatever command the agent commits with. It is also registered as
 * a config-defined hook (Git 2.54+), which still runs when a tool such as husky moves `core.hooksPath`; when both run,
 * `addIfDifferent` adds the line once.
 */
export function cloneScript(input: CloneTarget & { configPath: string; identity?: GitIdentity }): string {
  const path = quote(input.path);
  const hooks = `${input.path}/.git/hooks`;

  return [
    'set -e',
    `git config --global --replace-all include.path ${quote(input.configPath)}`,
    `if [ ! -d ${path}/.git ]; then`,
    // Cloned beside the checkout and moved into place whole, so a clone still running never looks done.
    `  staging=$(mktemp -d ${quote(input.path + '.cloning.')}XXXXXX)`,
    `  trap 'rm -rf "$staging"' EXIT`,
    `  GIT_TERMINAL_PROMPT=0 git clone${input.branch ? ' --branch ' + quote(input.branch) : ''} -- ${quote(input.url)} "$staging"`,
    `  [ -d ${path}/.git ] || mv -T "$staging" ${path}`,
    'fi',
    `git -C ${path} config user.name ${quote(BOT_NAME)}`,
    `git -C ${path} config user.email ${quote(BOT_EMAIL)}`,
    ...(input.identity
      ? [
          `mkdir -p ${quote(hooks)}`,
          `printf '%s\n' ${quote(coAuthorHook(input.identity))} > ${quote(`${hooks}/prepare-commit-msg`)}`,
          `chmod +x ${quote(`${hooks}/prepare-commit-msg`)}`,
          `git -C ${path} config hook.cloud-swe-co-author.event prepare-commit-msg`,
          // Resolved at commit time: the checkout path is relative, and `--git-path` would follow core.hooksPath.
          `git -C ${path} config hook.cloud-swe-co-author.command ${quote('"$(git rev-parse --git-common-dir)/hooks/prepare-commit-msg"')}`,
        ]
      : []),
  ].join('\n');
}

/** Makes the sandbox's Git access current and builds the clone command; undefined when Git access is unavailable. */
export async function prepareClone(host: ToolHost, workspace: WorkspaceRecord, target: CloneTarget) {
  const root = await sandboxRoot(host.env, workspace);
  let configPath: string;

  try {
    configPath = await ensureGitAccess(host, workspace, root);
  } catch {
    return undefined;
  }

  const identity = await credentialsStub(host.env).githubIdentity();

  return { root, identity, script: cloneScript({ ...target, configPath, identity }) };
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
  await registerRepo(storage, repo.url, directory(repo));
}

/**
 * The clone is a detached, unreconciled command, because no Pi task exists yet: if it does not finish, the
 * agent's git_clone is idempotent and completes it.
 */
export async function startInitialClone(host: ToolHost, repo: Repo): Promise<void> {
  try {
    const workspace = await toolWorkspace(host);
    const clone = await prepareClone(host, workspace, { url: repo.url, path: directory(repo), branch: repo.branch });

    if (clone) {
      await dispatchRemoteCommand(
        host.env,
        workspace,
        `cd ${quote(clone.root)}\n${clone.script}`,
        AbortSignal.timeout(10_000),
      );
    }
  } catch {
    // The repo stays registered; the agent can clone it with git_clone.
  }
}
