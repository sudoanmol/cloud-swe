/**
 * Path: server/src/git/approval-exec.ts
 * Used by: server/src/git/approvals.ts.
 * Purpose: Executes an approved ref update or PR merge against GitHub with a lease check, and reconciles one whose outcome is unknown by reading state.
 */

import type { Approval } from '@cloud-swe/protocol/git';
import { z } from 'zod';

import { GitHubError, githubJson, GitHubPull, readRef, writeRef } from './github.ts';

const GitHubMerge = z.object({ merged: z.boolean() });

type Outcome = { state: 'succeeded' | 'failed' | 'unknown'; result: string };

/** Both ref approvals as one change, with the words each reports in. */
type RefChange = {
  ref: string;
  sha: string | null;
  expected: string | null;
  force: boolean;
  name: string;
  what: string;
  done: string;
};

function refChange(approval: Extract<Approval, { kind: 'ref_update' | 'ref_change' }>): RefChange {
  const { sha, expected } = approval;

  if (approval.kind === 'ref_update') {
    const name = approval.targetBranch;

    return {
      ref: `refs/heads/${name}`,
      sha,
      expected,
      force: approval.force,
      name,
      what: `updating ${name} to ${sha}`,
      done: `Updated ${name} to ${sha}`,
    };
  }

  const { ref } = approval;

  return {
    ref,
    sha,
    expected,
    force: false,
    name: ref,
    what: sha ? `creating ${ref}` : `deleting ${ref}`,
    done: sha ? `Created ${ref}` : `Deleted ${ref}`,
  };
}

const readPull = (token: string, slug: string, number: number) =>
  githubJson(GitHubPull, token, 'GET', `/repos/${slug}/pulls/${number}`);

/** A definite refusal from GitHub fails the approval. Anything else may or may not have been applied. */
async function dispatch(what: string, send: () => Promise<Outcome>): Promise<Outcome> {
  try {
    return await send();
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;

    return error.status >= 400 && error.status < 500
      ? { state: 'failed', result: `GitHub refused ${what} (HTTP ${error.status})` }
      : { state: 'unknown', result: `The result of ${what} is unknown (${error.message})` };
  }
}

// ponytail: the lease is check-then-act. GitHub's REST ref API has no compare-and-swap, so a push landing between the
// read below and the write is overwritten (ceiling). The upgrade path is a receive-pack through the Git proxy with
// old = expected, which GitHub applies atomically or refuses; the same applies to the merge's head and base checks.
async function executeRef(token: string, slug: string, change: RefChange): Promise<Outcome> {
  const current = await readRef(token, slug, change.ref);

  if (current !== change.expected) {
    return { state: 'failed', result: `${change.name} moved since the request (now ${current ?? 'absent'})` };
  }

  return dispatch(change.what, async () => {
    await writeRef(token, slug, change.ref, current, change.sha, change.force);

    return { state: 'succeeded', result: change.done };
  });
}

async function executeMerge(
  token: string,
  slug: string,
  approval: Extract<Approval, { kind: 'pr_merge' }>,
): Promise<Outcome> {
  const pull = await readPull(token, slug, approval.number);

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

  return dispatch(`merging PR #${approval.number}`, async () => {
    const merged = await githubJson(GitHubMerge, token, 'PUT', `/repos/${slug}/pulls/${approval.number}/merge`, {
      sha: approval.expected,
      merge_method: approval.method,
    });

    return merged.merged
      ? { state: 'succeeded', result: `Merged PR #${approval.number} (${approval.method})` }
      : { state: 'failed', result: `GitHub did not merge PR #${approval.number}` };
  });
}

/** A fresh execution. Read failures before dispatch change nothing, so they are `unknown` and can be retried. */
export async function executeApproval(token: string, slug: string, approval: Approval): Promise<Outcome> {
  try {
    return approval.kind === 'pr_merge'
      ? await executeMerge(token, slug, approval)
      : await executeRef(token, slug, refChange(approval));
  } catch {
    return { state: 'unknown', result: 'Could not read the current GitHub state' };
  }
}

/** Reads GitHub instead of dispatching again. Throws when GitHub cannot be read. */
export async function reconcileApproval(
  token: string,
  slug: string,
  approval: Approval,
): Promise<'applied' | 'unchanged' | 'diverged'> {
  if (approval.kind === 'pr_merge') {
    const pull = await readPull(token, slug, approval.number);

    if (pull.merged) return 'applied';

    return pull.state === 'open' && pull.head.sha === approval.expected ? 'unchanged' : 'diverged';
  }

  const change = refChange(approval);
  const current = await readRef(token, slug, change.ref);

  if (current === change.sha) return 'applied';

  return current === change.expected ? 'unchanged' : 'diverged';
}
