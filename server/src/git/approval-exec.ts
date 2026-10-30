/**
 * Path: server/src/git/approval-exec.ts
 * Used by: server/src/git/approval-flow.ts.
 * Purpose: Executes an approved ref update or PR merge against GitHub with a lease check, and reconciles one whose outcome is unknown by reading state.
 */
import { type Approval, repoParts } from '@cloud-swe/protocol/git';

import { GitHubError, githubJson } from './github';
import { GitHubMerge, GitHubPull, GitHubRef } from './github-schemas';

export type Outcome = { state: 'succeeded' | 'failed' | 'unknown'; result: string };

/** What reading GitHub says about an approval that was dispatched, or may have been. */
export type Reconciled = 'applied' | 'unchanged' | 'diverged';

function slug(approval: Approval): string {
  const parts = repoParts(approval.repo);

  if (parts.kind !== 'github') throw new Error('Approvals only cover GitHub repositories');

  return `${parts.owner}/${parts.repo}`;
}

/** The branch tip, or null when the branch does not exist. */
async function readRef(token: string, repo: string, branch: string): Promise<string | null> {
  try {
    return (await githubJson(GitHubRef, token, 'GET', `/repos/${repo}/git/ref/heads/${branch}`)).object.sha;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return null;

    throw error;
  }
}

const readPull = (token: string, repo: string, number: number) =>
  githubJson(GitHubPull, token, 'GET', `/repos/${repo}/pulls/${number}`);

/** A definite refusal from GitHub fails the approval. Anything else may or may not have been applied. */
function dispatchOutcome(error: GitHubError, what: string): Outcome {
  return error.status >= 400 && error.status < 500
    ? { state: 'failed', result: `GitHub refused ${what} (HTTP ${error.status})` }
    : { state: 'unknown', result: `The result of ${what} is unknown (${error.message})` };
}

async function executeRefUpdate(token: string, approval: Extract<Approval, { kind: 'ref_update' }>): Promise<Outcome> {
  const repo = slug(approval);
  const what = `updating ${approval.targetBranch} to ${approval.sha}`;
  const current = await readRef(token, repo, approval.targetBranch);

  if (current !== approval.expected) {
    return { state: 'failed', result: `${approval.targetBranch} moved since the request (now ${current ?? 'absent'})` };
  }

  try {
    if (current === null) {
      await githubJson(GitHubRef, token, 'POST', `/repos/${repo}/git/refs`, {
        ref: `refs/heads/${approval.targetBranch}`,
        sha: approval.sha,
      });
    } else {
      await githubJson(GitHubRef, token, 'PATCH', `/repos/${repo}/git/refs/heads/${approval.targetBranch}`, {
        sha: approval.sha,
        force: approval.force,
      });
    }
  } catch (error) {
    if (error instanceof GitHubError) return dispatchOutcome(error, what);

    throw error;
  }

  return { state: 'succeeded', result: `Updated ${approval.targetBranch} to ${approval.sha}` };
}

async function executeMerge(token: string, approval: Extract<Approval, { kind: 'pr_merge' }>): Promise<Outcome> {
  const repo = slug(approval);
  const pull = await readPull(token, repo, approval.number);

  if (pull.merged || pull.state !== 'open') return { state: 'failed', result: `PR #${approval.number} is not open` };

  if (pull.head.sha !== approval.expected) {
    return { state: 'failed', result: `PR #${approval.number} head moved since the request (now ${pull.head.sha})` };
  }

  // github_pr_update can retarget the PR; the user approved a merge into the branch they were shown.
  if (pull.base.ref !== approval.baseRef) {
    return {
      state: 'failed',
      result: `PR #${approval.number} base moved from ${approval.baseRef} to ${pull.base.ref} since the request`,
    };
  }

  try {
    const merged = await githubJson(GitHubMerge, token, 'PUT', `/repos/${repo}/pulls/${approval.number}/merge`, {
      sha: approval.expected,
      merge_method: approval.method,
    });

    return merged.merged
      ? { state: 'succeeded', result: `Merged PR #${approval.number} (${approval.method})` }
      : { state: 'failed', result: `GitHub did not merge PR #${approval.number}` };
  } catch (error) {
    if (error instanceof GitHubError) return dispatchOutcome(error, `merging PR #${approval.number}`);

    throw error;
  }
}

/** A fresh execution. Read failures before dispatch change nothing, so they are `unknown` and can be retried. */
export async function executeApproval(token: string, approval: Approval): Promise<Outcome> {
  try {
    return approval.kind === 'ref_update'
      ? await executeRefUpdate(token, approval)
      : await executeMerge(token, approval);
  } catch {
    return { state: 'unknown', result: 'Could not read the current GitHub state' };
  }
}

/** Reads GitHub instead of dispatching again. Throws when GitHub cannot be read. */
export async function reconcileApproval(token: string, approval: Approval): Promise<Reconciled> {
  if (approval.kind === 'ref_update') {
    const current = await readRef(token, slug(approval), approval.targetBranch);

    if (current === approval.sha) return 'applied';

    return current === approval.expected ? 'unchanged' : 'diverged';
  }

  const pull = await readPull(token, slug(approval), approval.number);

  if (pull.merged) return 'applied';

  return pull.state === 'open' && pull.head.sha === approval.expected ? 'unchanged' : 'diverged';
}
