/**
 * Path: server/src/git/initial-repo.ts
 * Used by: server/src/sessions/thread.ts.
 * Purpose: Registers the repo requested at session creation as the base and starts its clone in the sandbox.
 */
import type { InitialRepo } from '@cloud-swe/protocol/git';
import type { z } from 'zod';

import { type ToolHost, toolWorkspace } from '../tools/host';
import { dispatchRemoteCommand, remoteFileInfo } from '../tools/remote';
import { quote } from '../tools/runner';
import { gitConfigPath, refreshGitAccess } from './access';
import { cloneScript } from './clone';
import { defaultPath, registerRepo } from './repos';

/**
 * Registration is durable and decides authorization. The clone is a detached, unreconciled command, because
 * no Pi task exists yet: if it does not finish, the agent's git_clone is idempotent and completes it.
 */
export async function setupInitialRepo(host: ToolHost, repo: z.output<typeof InitialRepo>): Promise<void> {
  await registerRepo(host.storage, repo.url, defaultPath(repo.url), true);

  try {
    await refreshGitAccess(host);
    const workspace = await toolWorkspace(host);
    const root = (await remoteFileInfo(host.env, workspace, '.', AbortSignal.timeout(5000))).path;
    const identity = await host.env.CREDENTIALS.get(host.env.CREDENTIALS.idFromName('personal')).githubIdentity();

    const script = cloneScript({
      url: repo.url,
      path: defaultPath(repo.url),
      branch: repo.branch,
      configPath: await gitConfigPath(host),
      identity,
    });

    await dispatchRemoteCommand(host.env, workspace, `cd ${quote(root)}\n${script}`, AbortSignal.timeout(10_000));
  } catch {
    // The repo stays registered; the agent can clone it with git_clone.
  }
}
