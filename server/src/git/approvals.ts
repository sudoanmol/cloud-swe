/**
 * Path: server/src/git/approvals.ts
 * Used by: server/src/git/approval-tools.ts, server/src/sessions/thread.ts.
 * Purpose: Approval records in Thread storage and their projection into Session.approvals; applying a user decision, persisting each transition before dispatch; and the durable job that delivers each outcome to the agent as one follow-up message.
 */

import { SubmitMessageRequest } from '@cloud-swe/protocol';
import { Approval, repoParts } from '@cloud-swe/protocol/git';
import { StoredApproval } from '@cloud-swe/protocol/storage';
import { LifecycleCapability, type LifecycleJobOutcome } from 'agents/lifecycle';

import { apiError } from '../errors.ts';
import { readParsed } from '../storage.ts';
import { executeApproval, reconcileApproval } from './approval-exec.ts';
import { deterministicUuid } from './ids.ts';
import { markPullMerged } from './pull-requests.ts';
import { isZero, type PushCommand } from './push.ts';

type Reader = Pick<DurableObjectStorage, 'get' | 'list'>;

type Writer = Pick<DurableObjectStorage, 'put'>;

const PREFIX = 'approval:';

// Open approvals always show; this many decided ones stay visible so clients can render outcomes.
const RECENT_DECIDED = 20;

const isOpen = (approval: Approval) =>
  approval.state === 'pending' || approval.state === 'executing' || approval.state === 'unknown';

export async function readApproval(storage: Reader, id: string): Promise<StoredApproval | undefined> {
  return readParsed(storage, PREFIX + id, StoredApproval);
}

export async function writeApproval(storage: Writer, stored: StoredApproval) {
  await storage.put(PREFIX + stored.approval.id, StoredApproval.parse(stored));
}

async function listApprovals(storage: Reader): Promise<StoredApproval[]> {
  const rows = await storage.list<unknown>({ prefix: PREFIX });

  return [...rows.values()]
    .map((raw) => StoredApproval.parse(raw))
    .toSorted((a, b) => a.approval.createdAt.localeCompare(b.approval.createdAt));
}

/**
 * Files a push the policy refused so the user can allow or block it, and returns the reason git prints to the agent.
 * The ID names the exact change, so retrying the same push files nothing new and a blocked one is not asked again.
 */
export async function fileBlockedPush(
  storage: Reader & Writer,
  repo: string,
  { ref, old, new: next }: PushCommand,
): Promise<string> {
  const id = await deterministicUuid(`blocked:${repo}:${ref}:${old}:${next}`);
  const existing = await readApproval(storage, id);

  if (existing?.approval.state === 'rejected') return 'the user blocked this push';

  if (existing && !isOpen(existing.approval)) return `this push already ${existing.approval.state} as approval ${id}`;

  if (!existing) {
    await writeApproval(storage, {
      delivered: false,
      approval: Approval.parse({
        id,
        kind: 'ref_change',
        repo,
        state: 'pending',
        ref,
        sha: isZero(next) ? null : next,
        expected: isZero(old) ? null : old,
        createdAt: new Date().toISOString(),
      }),
    });
  }

  return `blocked and sent to the user to allow (approval ${id}); do not retry, the result arrives as a message`;
}

/** Open approvals plus the newest decided ones, oldest first. */
export async function approvalProjection(storage: Reader): Promise<Approval[]> {
  const all = (await listApprovals(storage)).map((stored) => stored.approval);
  const decided = all.filter((approval) => !isOpen(approval)).slice(-RECENT_DECIDED);

  return all.filter((approval) => isOpen(approval) || decided.includes(approval)).slice(-100);
}

export type ApprovalHost = {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'list'>;
  githubToken: (owner: string, repo: string) => Promise<string | undefined>;
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
async function deliverPending(host: ApprovalHost): Promise<boolean> {
  let remaining = false;

  for (const stored of await listApprovals(host.storage)) {
    // A decision in flight delivers its own result; stay scheduled in case that delivery is refused.
    if (inflight.has(stored.approval.id)) {
      remaining = true;
      continue;
    }

    if (needsDelivery(stored) && !(await deliverOnce(host, stored)).delivered) remaining = true;
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
  const parts = repoParts(initial.approval.repo);

  if (parts?.kind !== 'github') throw new Error('Approvals only target GitHub repositories');
  // A failed mint throws and leaves the approval as it was, so the user can decide again.
  const token = await host.githubToken(parts.owner, parts.repo);
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

const JOB = 'approval-delivery';
const RETRY_MS = 15_000;

/**
 * Delivery is refused while the session is settling or has no model, and can fail when a sandbox will not resume.
 * The job lives in the Thread's own alarm queue, so a refusal or a restart does not lose the agent's result.
 * It only delivers messages; it never executes or reconciles anything on GitHub.
 */
export class ApprovalDelivery extends LifecycleCapability {
  readonly host: () => ApprovalHost;

  constructor(host: () => ApprovalHost) {
    super('approval-delivery');
    this.host = host;
  }

  /** Check back soon. Pushing the same ID replaces the pending job, so this is idempotent. */
  async watch(): Promise<void> {
    await this.lifecycle.jobs.push({ id: JOB, fn: JOB, time: Date.now() + RETRY_MS, singleflight: true });
  }

  async onJob(): Promise<LifecycleJobOutcome> {
    return (await deliverPending(this.host())) ? this.later() : undefined;
  }

  // An unreachable catalog or sandbox must not end the job; Lifecycle would otherwise complete it.
  onJobError(): LifecycleJobOutcome {
    return this.later();
  }

  private later(): LifecycleJobOutcome {
    return { rescheduleAt: Date.now() + RETRY_MS };
  }
}
