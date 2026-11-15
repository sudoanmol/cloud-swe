/**
 * Path: server/src/git/approvals.ts
 * Used by: server/src/git/approval-tools.ts, server/src/sessions/thread.ts.
 * Purpose: Approval records in Thread storage and their projection into Session.approvals; applying a user decision, persisting each transition before dispatch; and delivering each outcome to the agent as one follow-up message.
 */

import { FOLLOW_UP_LIMIT } from '@cloud-swe/protocol';
import { Approval, repoParts } from '@cloud-swe/protocol/git';
import { StoredApproval } from '@cloud-swe/protocol/storage';
import type { z } from 'zod';

import { apiError } from '../errors.ts';
import { type FollowUpHost, followUps } from '../follow-ups.ts';
import { deterministicUuid } from '../ids.ts';
import type { KvLister, KvReader, KvWriter } from '../storage.ts';
import { executeApproval, reconcileApproval } from './approval-exec.ts';
import { markPullMerged } from './pull-store.ts';
import { isZero, type PushCommand } from './push.ts';

const isOpen = (approval: Approval) =>
  approval.state === 'pending' || approval.state === 'executing' || approval.state === 'unknown';

function describe(approval: Approval): string {
  if (approval.kind === 'ref_change') {
    return `${approval.sha ? `create ${approval.ref} at ${approval.sha}` : `delete ${approval.ref}`} of ${approval.repo}`;
  }

  return approval.kind === 'ref_update'
    ? `${approval.force ? 'force-update' : 'update'} ${approval.targetBranch} of ${approval.repo} to ${approval.sha}`
    : `merge PR #${approval.number} of ${approval.repo} into ${approval.baseRef} (${approval.method})`;
}

const approvals = followUps({
  prefix: 'approval:',
  schema: StoredApproval,
  item: (stored) => stored.approval,
  isOpen,
  // A decided approval and an `unknown` one both tell the agent something it is waiting for. The key names the outcome
  // itself, so a later, different outcome of the same approval (unknown, then succeeded) is a new message.
  outcome: (approval) =>
    approval.state === 'pending' || approval.state === 'executing'
      ? undefined
      : {
          key: `approval-result:${approval.id}:${approval.state}:${approval.result ?? ''}`,
          mode: 'followUp',
          text: `Approval ${approval.id} to ${describe(approval)} is ${approval.state}${approval.result ? ': ' + approval.result : ''}.`,
        },
});

export const readApproval = approvals.read;

type Unfiled<T> = T extends unknown ? Omit<T, 'state' | 'createdAt'> : never;

export async function fileApproval(storage: KvWriter, approval: Unfiled<z.input<typeof Approval>>) {
  await approvals.write(storage, {
    delivered: false,
    approval: Approval.parse({ ...approval, state: 'pending', createdAt: new Date().toISOString() }),
  });
}

/**
 * Files a push the policy refused so the user can allow or block it, and returns the reason git prints to the agent.
 * The ID names the exact change, so retrying the same push files nothing new and a blocked one is not asked again.
 */
export async function fileBlockedPush(
  storage: KvReader & KvWriter,
  repo: string,
  { ref, old, new: next }: PushCommand,
): Promise<string> {
  const id = await deterministicUuid(`blocked:${repo}:${ref}:${old}:${next}`);
  const existing = await readApproval(storage, id);

  if (existing?.approval.state === 'rejected') return 'the user blocked this push';

  if (existing && !isOpen(existing.approval)) return `this push already ${existing.approval.state} as approval ${id}`;

  if (!existing) {
    await fileApproval(storage, {
      id,
      kind: 'ref_change',
      repo,
      ref,
      sha: isZero(next) ? null : next,
      expected: isZero(old) ? null : old,
    });
  }

  return `blocked and sent to the user to allow (approval ${id}); do not retry, the result arrives as a message`;
}

/** Open approvals plus the newest decided ones, oldest first. */
export const approvalProjection = async (storage: KvLister) =>
  (await approvals.visible(storage)).slice(-FOLLOW_UP_LIMIT);

export type ApprovalHost = FollowUpHost & {
  githubToken: (owner: string, repo: string) => Promise<string | undefined>;
};

type Decided = { approval: Approval } | { error: 'approval_not_found' | 'approval_already_decided' };

// One decision at a time per approval, so a repeated POST during a dispatch cannot dispatch again.
const inflight = new Map<string, Promise<Decided>>();

/** Never executes anything on GitHub. */
export const deliverApprovals = (host: FollowUpHost) => approvals.deliverAll(host, (id) => inflight.has(id));

async function transition(
  host: ApprovalHost,
  stored: StoredApproval,
  change: Partial<Pick<Approval, 'state' | 'result' | 'decidedAt'>>,
): Promise<StoredApproval> {
  // A new state is a new outcome, owed to the agent again.
  const next = StoredApproval.parse({ delivered: false, approval: { ...stored.approval, ...change } });
  await approvals.write(host.storage, next);
  host.changed();

  if (next.approval.kind === 'pr_merge' && next.approval.state === 'succeeded') {
    await markPullMerged(host.storage, next.approval.repo, next.approval.number);
  }

  return next;
}

async function approve(host: ApprovalHost, initial: StoredApproval): Promise<StoredApproval> {
  const parts = repoParts(initial.approval.repo);

  if (parts?.kind !== 'github') throw new Error('Approvals only target GitHub repositories');
  // A failed mint throws and leaves the approval as it was, so the user can decide again.
  const token = await host.githubToken(parts.owner, parts.repo);
  const slug = `${parts.owner}/${parts.repo}`;
  let stored = initial;

  if (!token) {
    return stored.approval.state === 'pending'
      ? transition(host, stored, {
          state: 'failed',
          result: 'The GitHub App is not installed on this repository',
          decidedAt: new Date().toISOString(),
        })
      : stored;
  }

  if (stored.approval.state === 'pending') {
    // Persisted before any dispatch: a crash after this point is reconciled, never blindly repeated.
    stored = await transition(host, stored, { state: 'executing', decidedAt: new Date().toISOString() });
  } else {
    let reconciled: Awaited<ReturnType<typeof reconcileApproval>>;

    try {
      reconciled = await reconcileApproval(token, slug, stored.approval);
    } catch {
      return transition(host, stored, { state: 'unknown', result: 'GitHub could not be read to confirm the outcome' });
    }

    if (reconciled === 'applied')
      return transition(host, stored, { state: 'succeeded', result: 'Confirmed applied on GitHub' });

    if (reconciled === 'diverged') {
      return transition(host, stored, {
        state: 'unknown',
        result: 'GitHub changed since the request, so it cannot be told whether this was applied',
      });
    }

    stored = await transition(host, stored, { state: 'executing' });
  }

  const outcome = await executeApproval(token, slug, stored.approval);

  return transition(host, stored, outcome);
}

async function decideOnce(host: ApprovalHost, id: string, decision: 'approve' | 'reject'): Promise<Decided> {
  let stored = await readApproval(host.storage, id);

  if (!stored) return { error: 'approval_not_found' };
  // Armed before any transition, so a crash after one still leaves a job to deliver it.
  await host.armDelivery();
  const state = stored.approval.state;

  if (decision === 'reject') {
    if (state === 'pending') {
      stored = await transition(host, stored, {
        state: 'rejected',
        result: 'Rejected by the user',
        decidedAt: new Date().toISOString(),
      });
    } else if (state !== 'rejected') {
      return { error: 'approval_already_decided' };
    }
  } else if (state === 'rejected') {
    return { error: 'approval_already_decided' };
  } else if (isOpen(stored.approval)) {
    stored = await approve(host, stored);
  }

  return { approval: (await approvals.deliver(host, stored)).approval };
}

export async function decideApproval(
  host: ApprovalHost,
  id: string,
  decision: 'approve' | 'reject',
): Promise<Response> {
  let running = inflight.get(id);

  if (!running) {
    running = decideOnce(host, id, decision).finally(() => inflight.delete(id));
    inflight.set(id, running);
  }

  const decided = await running;

  return 'error' in decided ? apiError(decided.error) : Response.json(decided.approval);
}
