import { SubmitMessageRequest } from '@cloud-swe/protocol';
/**
 * Path: server/src/git/approval-flow.ts
 * Used by: server/src/git/approval-delivery.ts, server/src/sessions/thread.ts.
 * Purpose: Applies a user's decision to an approval: persists each transition before dispatch, executes or reconciles, and delivers each outcome to the agent as one follow-up message.
 */
import type { Approval } from '@cloud-swe/protocol/git';
import { StoredApproval } from '@cloud-swe/protocol/storage';

import { apiError } from '../http';
import { executeApproval, reconcileApproval } from './approval-exec';
import { listApprovals, readApproval, writeApproval } from './approvals';
import { deterministicUuid } from './ids';
import { markPullMerged } from './pull-records';

export type ApprovalHost = {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'list'>;
  githubToken: () => Promise<string | undefined>;
  // Whether the session admitted the message. Admission is idempotent on the operation ID.
  deliver: (request: SubmitMessageRequest) => Promise<boolean>;
  // Makes sure the durable delivery job will retry whatever this decision leaves undelivered.
  armDelivery: () => Promise<void>;
};

// One decision at a time per approval, so a repeated POST during a dispatch cannot dispatch again.
const inflight = new Map<string, Promise<{ status: number; body: string }>>();

function describe(approval: Approval): string {
  if (approval.kind === 'ref_change') {
    return `${approval.sha ? `create ${approval.ref} at ${approval.sha}` : `delete ${approval.ref}`} of ${approval.repo}`;
  }

  return approval.kind === 'ref_update'
    ? `${approval.force ? 'force-update' : 'update'} ${approval.targetBranch} of ${approval.repo} to ${approval.sha}`
    : `merge PR #${approval.number} of ${approval.repo} into ${approval.baseRef} (${approval.method})`;
}

function resultMessage(approval: Approval): string {
  return `Approval ${approval.id} to ${describe(approval)} is ${approval.state}${approval.result ? ': ' + approval.result : ''}.`;
}

const isFinal = (approval: Approval) =>
  approval.state === 'succeeded' || approval.state === 'failed' || approval.state === 'rejected';

// A decided approval and an `unknown` one both tell the agent something it is waiting for.
const needsDelivery = ({ approval, delivered }: StoredApproval) =>
  !delivered && (isFinal(approval) || approval.state === 'unknown');

/**
 * Sends the current outcome. The operation ID names the outcome itself (state and result), so a retry is harmless and
 * a later, different outcome of the same approval (unknown, then succeeded) is a new message. A refusal or a throw
 * leaves the approval undelivered for the delivery job.
 */
async function deliverOnce(host: ApprovalHost, stored: StoredApproval): Promise<StoredApproval> {
  if (!needsDelivery(stored)) return stored;
  const { approval } = stored;

  const admitted = await host
    .deliver(
      SubmitMessageRequest.parse({
        operationId: await deterministicUuid(
          `approval-result:${approval.id}:${approval.state}:${approval.result ?? ''}`,
        ),
        mode: 'followUp',
        text: resultMessage(approval),
      }),
    )
    .catch(() => false);

  if (!admitted) return stored;

  // A decision may have moved the approval on while the message was admitted; that outcome is delivered on its own.
  const latest = await readApproval(host.storage, approval.id);

  if (!latest || JSON.stringify(latest.approval) !== JSON.stringify(approval)) return latest ?? stored;
  const next = { ...latest, delivered: true };
  await writeApproval(host.storage, next);

  return next;
}

/** Delivers every outcome still owed to the agent. Returns whether any remains. Never executes anything on GitHub. */
export async function deliverPending(host: ApprovalHost): Promise<boolean> {
  let remaining = false;

  for (const stored of await listApprovals(host.storage)) {
    if (!needsDelivery(stored)) continue;

    // A decision in flight delivers its own result.
    if (inflight.has(stored.approval.id) || !(await deliverOnce(host, stored)).delivered) remaining = true;
  }

  return remaining;
}

async function transition(
  host: ApprovalHost,
  stored: StoredApproval,
  change: Partial<Pick<Approval, 'state' | 'result' | 'decidedAt'>>,
): Promise<StoredApproval> {
  // A new state is a new outcome, owed to the agent again.
  const next = StoredApproval.parse({ delivered: false, approval: { ...stored.approval, ...change } });
  await writeApproval(host.storage, next);

  if (next.approval.kind === 'pr_merge' && next.approval.state === 'succeeded') {
    await markPullMerged(host.storage, next.approval.repo, next.approval.number);
  }

  return next;
}

async function approve(host: ApprovalHost, initial: StoredApproval): Promise<StoredApproval> {
  const token = await host.githubToken();
  let stored = initial;

  if (!token) {
    return stored.approval.state === 'pending'
      ? transition(host, stored, {
          state: 'failed',
          result: 'No GitHub token is configured',
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
      reconciled = await reconcileApproval(token, stored.approval);
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

  const outcome = await executeApproval(token, stored.approval);

  return transition(host, stored, outcome);
}

async function decideOnce(host: ApprovalHost, id: string, decision: 'approve' | 'reject'): Promise<Response> {
  let stored = await readApproval(host.storage, id);

  if (!stored) return apiError('approval_not_found');
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
      return apiError('approval_already_decided');
    }
  } else if (state === 'rejected') {
    return apiError('approval_already_decided');
  } else if (state === 'pending' || state === 'executing' || state === 'unknown') {
    stored = await approve(host, stored);
  }

  stored = await deliverOnce(host, stored);

  return Response.json(stored.approval);
}

export async function decideApproval(
  host: ApprovalHost,
  id: string,
  decision: 'approve' | 'reject',
): Promise<Response> {
  let running = inflight.get(id);

  if (!running) {
    // Bodies are read once, here, so every concurrent caller gets its own Response.
    running = decideOnce(host, id, decision)
      .then(async (response) => ({ status: response.status, body: await response.text() }))
      .finally(() => inflight.delete(id));
    inflight.set(id, running);
  }

  const { status, body } = await running;

  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}
