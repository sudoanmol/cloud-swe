/**
 * Path: server/src/git/approvals.ts
 * Used by: server/src/git/{approval-tools,approval-flow,approval-exec}.ts, server/src/sessions/thread.ts.
 * Purpose: Approval records in Thread storage and their bounded projection into Session.approvals.
 */
import { Approval } from '@cloud-swe/protocol/git';
import { StoredApproval } from '@cloud-swe/protocol/storage';

import { deterministicUuid } from './ids';
import { isZero, type PushCommand } from './pktline.ts';

type Reader = Pick<DurableObjectStorage, 'get' | 'list'>;

type Writer = Pick<DurableObjectStorage, 'put'>;

const PREFIX = 'approval:';

// Open approvals always show; this many decided ones stay visible so clients can render outcomes.
const RECENT_DECIDED = 20;

const isOpen = (approval: Approval) =>
  approval.state === 'pending' || approval.state === 'executing' || approval.state === 'unknown';

export async function readApproval(storage: Reader, id: string): Promise<StoredApproval | undefined> {
  const raw = await storage.get<unknown>(PREFIX + id);

  return raw === undefined ? undefined : StoredApproval.parse(raw);
}

export async function writeApproval(storage: Writer, stored: StoredApproval) {
  await storage.put(PREFIX + stored.approval.id, StoredApproval.parse(stored));
}

export async function listApprovals(storage: Reader): Promise<StoredApproval[]> {
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
