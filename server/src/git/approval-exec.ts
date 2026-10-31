/**
 * Path: server/src/git/approval-exec.ts
 * Used by: server/src/git/approvals.ts.
 * Purpose: Executes an approved ref update or PR merge against GitHub with a lease check, and reconciles one whose outcome is unknown by reading state.
 */

import { type Approval, repoParts } from '@cloud-swe/protocol/git';

import { github, GitHubError, githubJson, GitHubMerge, GitHubPull, GitHubRef } from './github.ts';

export type Outcome = { state: 'succeeded' | 'failed' | 'unknown'; result: string };

/** What reading GitHub says about an approval that was dispatched, or may have been. */
export type Reconciled = 'applied' | 'unchanged' | 'diverged';

function slug(approval: Approval): string {
  const parts = repoParts(approval.repo);

  if (parts.kind !== 'github') throw new Error('Approvals only cover GitHub repositories');

  return `${parts.owner}/${parts.repo}`;
}

/** The ref's target, or null when it does not exist. `ref` is relative to refs/, such as heads/main. */
async function readRef(token: string, repo: string, ref: string): Promise<string | null> {
  try {
    return (await githubJson(GitHubRef, token, 'GET', `/repos/${repo}/git/ref/${ref}`)).object.sha;
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

// ponytail: the lease is check-then-act. GitHub's REST ref API has no compare-and-swap, so a push landing between the
// read below and the PATCH is overwritten (ceiling). The upgrade path is a receive-pack through the Git proxy with
// old = expected, which GitHub applies atomically or refuses; the same applies to the merge's head and base checks.
async function executeRefUpdate(token: string, approval: Extract<Approval, { kind: 'ref_update' }>): Promise<Outcome> {
  const repo = slug(approval);
  const what = `updating ${approval.targetBranch} to ${approval.sha}`;
  const current = await readRef(token, repo, `heads/${approval.targetBranch}`);

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

async function executeRefChange(token: string, approval: Extract<Approval, { kind: 'ref_change' }>): Promise<Outcome> {
  const repo = slug(approval);
  const short = approval.ref.slice('refs/'.length);
  const what = approval.sha ? `creating ${approval.ref}` : `deleting ${approval.ref}`;
  const current = await readRef(token, repo, short);

  if (current !== approval.expected) {
    return { state: 'failed', result: `${approval.ref} moved since the request (now ${current ?? 'absent'})` };
  }

  try {
    if (approval.sha) {
      await githubJson(GitHubRef, token, 'POST', `/repos/${repo}/git/refs`, { ref: approval.ref, sha: approval.sha });
    } else {
      const deleted = await github(token, 'DELETE', `/repos/${repo}/git/refs/${short}`);

      if (!deleted.ok) throw new GitHubError(deleted.status, 'delete failed');
    }
  } catch (error) {
    if (error instanceof GitHubError) return dispatchOutcome(error, what);

    throw error;
  }

  return { state: 'succeeded', result: approval.sha ? `Created ${approval.ref}` : `Deleted ${approval.ref}` };
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
    if (approval.kind === 'ref_update') return await executeRefUpdate(token, approval);

    if (approval.kind === 'ref_change') return await executeRefChange(token, approval);

    return await executeMerge(token, approval);
  } catch {
    return { state: 'unknown', result: 'Could not read the current GitHub state' };
  }
}

/** Reads GitHub instead of dispatching again. Throws when GitHub cannot be read. */
export async function reconcileApproval(token: string, approval: Approval): Promise<Reconciled> {
  if (approval.kind === 'ref_update') {
    const current = await readRef(token, slug(approval), `heads/${approval.targetBranch}`);

    if (current === approval.sha) return 'applied';

    return current === approval.expected ? 'unchanged' : 'diverged';
  }

  if (approval.kind === 'ref_change') {
    const current = await readRef(token, slug(approval), approval.ref.slice('refs/'.length));

    if (current === approval.sha) return 'applied';

    return current === approval.expected ? 'unchanged' : 'diverged';
  }

  const pull = await readPull(token, slug(approval), approval.number);

  if (pull.merged) return 'applied';

  return pull.state === 'open' && pull.head.sha === approval.expected ? 'unchanged' : 'diverged';
}
