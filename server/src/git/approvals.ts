/**
 * Path: server/src/git/approvals.ts
 * Used by: server/src/git/{approval-tools,approval-flow,approval-exec}.ts, server/src/sessions/thread.ts.
 * Purpose: Approval records in Thread storage and their bounded projection into Session.approvals.
 */
import { Approval } from '@cloud-swe/protocol/git';
import { StoredApproval } from '@cloud-swe/protocol/storage';

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

/** Open approvals plus the newest decided ones, oldest first. */
export async function approvalProjection(storage: Reader): Promise<Approval[]> {
  const all = (await listApprovals(storage)).map((stored) => stored.approval);
  const decided = all.filter((approval) => !isOpen(approval)).slice(-RECENT_DECIDED);

  return all.filter((approval) => isOpen(approval) || decided.includes(approval)).slice(-100);
}
