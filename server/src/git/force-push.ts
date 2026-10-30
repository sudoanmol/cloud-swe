/**
 * Path: server/src/git/force-push.ts
 * Used by: server/src/git/proxy.ts.
 * Purpose: After a push to the session branch is forwarded, detects non-fast-forward updates and restores the old tip.
 */
import { githubJson } from './github';
import { GitHubCompare, GitHubRef } from './github-schemas';
import type { PushCommand } from './pktline.ts';

export const FORCE_REASON = 'force push requires approval: use git_request_ref_update';

/**
 * ponytail: the update is forwarded first and checked afterwards, so the session branch briefly shows the forced
 * commit before it is restored (ceiling). Parsing the pack to check ancestry before forwarding is the upgrade path.
 * The rejected commit stays on GitHub, which is what the approval path needs.
 */
export async function wasFastForward(
  token: string | undefined,
  owner: string,
  repo: string,
  command: PushCommand,
): Promise<boolean> {
  try {
    const { status } = await githubJson(
      GitHubCompare,
      token,
      'GET',
      `/repos/${owner}/${repo}/compare/${command.old}...${command.new}`,
    );

    return status === 'ahead' || status === 'identical';
  } catch {
    // Unverifiable counts as forced: restoring is safe, trusting is not.
    return false;
  }
}

/** Puts the branch back on its old tip. Returns whether GitHub confirmed it. */
export async function restoreRef(
  token: string | undefined,
  owner: string,
  repo: string,
  command: PushCommand,
): Promise<boolean> {
  try {
    const restored = await githubJson(
      GitHubRef,
      token,
      'PATCH',
      `/repos/${owner}/${repo}/git/refs/${command.ref.replace(/^refs\//, '')}`,
      { sha: command.old, force: true },
    );

    return restored.object.sha === command.old;
  } catch {
    return false;
  }
}
