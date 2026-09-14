import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import type { JsonObject } from "../json";
import * as schema from "../schema";
import { commandOperation, demoTurn, run, thread, threadEvent, workspace } from "../schema/threads";
import {
  ThreadStoreError,
  type RunRecord,
  type ThreadEvent,
  type WorkspaceRecord,
} from "../thread-contracts";

export type Db = NodePgDatabase<typeof schema>;

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const activeRunStatuses = ["queued", "running"] as const;

export const terminalRunStatuses = ["completed", "failed", "cancelled"] as const;

export const unsettledCommandStates = ["queued", "pending", "running", "unknown"] as const;

export const lifecycleLockKey = "cloud-swe:thread-admission:v1";

export function isTerminalRun(status: string): boolean {
  return terminalRunStatuses.some((candidate) => candidate === status);
}

export function isActiveRun(status: string): status is "queued" | "running" {
  return activeRunStatuses.some((candidate) => candidate === status);
}

const postgresErrorSchema = z.object({
  code: z.string().optional().catch(undefined),
  constraint: z.string().optional().catch(undefined),
  cause: z.unknown().optional(),
});

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Parse driver errors, including Drizzle's nested cause, at the database boundary.
export function postgresField(error: unknown, field: "code" | "constraint"): string | undefined {
  let current: unknown = error;

  for (let depth = 0; depth < 4; depth += 1) {
    const parsed = postgresErrorSchema.safeParse(current);

    if (!parsed.success) return undefined;
    const value = parsed.data[field];

    if (value !== undefined) return value;
    const cause = parsed.data.cause;

    if (cause === current) return undefined;
    current = cause;
  }

  return undefined;
}

export function uniqueAdmissionError(constraint: string | undefined): ThreadStoreError | null {
  if (constraint === "run_one_active_thread_idx")
    return new ThreadStoreError("THREAD_BUSY", "This thread already has an active run", 409);

  return null;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Historical event JSON must be validated before generation comparisons.
export function payloadNumber(payload: unknown, key: string): number | undefined {
  const parsed = z.object({ [key]: z.number() }).safeParse(payload);

  return parsed.success ? parsed.data[key] : undefined;
}

export async function settleTurn(tx: Tx, current: RunRecord, consume: boolean): Promise<boolean> {
  const rows = await tx
    .update(demoTurn)
    .set({ state: consume ? "consumed" : "released" })
    .where(and(eq(demoTurn.runId, current.id), eq(demoTurn.state, "reserved")))
    .returning();

  return !consume && rows.length > 0;
}

export async function appendEvent(
  tx: Tx,
  threadId: string,
  type: string,
  payload: JsonObject,
  dedupeKey: string,
): Promise<ThreadEvent> {
  const locked = await tx
    .select({ sequence: thread.eventSequence })
    .from(thread)
    .where(eq(thread.id, threadId))
    .for("update");

  if (!locked[0]) throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);

  const found = await tx
    .select()
    .from(threadEvent)
    .where(and(eq(threadEvent.threadId, threadId), eq(threadEvent.dedupeKey, dedupeKey)))
    .limit(1);

  if (found[0]) return found[0];

  const sequence = locked[0].sequence + 1;
  await tx
    .update(thread)
    .set({ eventSequence: sequence, updatedAt: new Date() })
    .where(eq(thread.id, threadId));

  const inserted = await tx
    .insert(threadEvent)
    .values({ threadId, sequence, type, payload, dedupeKey })
    .returning();

  if (!inserted[0])
    throw new ThreadStoreError("EVENT_CREATE_FAILED", "Could not append event", 500);

  return inserted[0];
}

export async function readWorkspaceForThread(tx: Tx, threadId: string) {
  const query = tx.select().from(workspace).where(eq(workspace.threadId, threadId)).limit(1);

  return query.for("update");
}

export async function lockThreadAndWorkspace(
  tx: Tx,
  threadId: string,
): Promise<WorkspaceRecord | null> {
  const owner = await tx
    .select({ id: thread.id })
    .from(thread)
    .where(eq(thread.id, threadId))
    .for("update")
    .limit(1);

  if (!owner[0]) throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);
  const rows = await readWorkspaceForThread(tx, threadId);

  return rows[0] ?? null;
}

export async function lockWorkspaceContext(
  tx: Tx,
  workspaceId: string,
): Promise<{ workspace: WorkspaceRecord; threadId: string }> {
  const first = await tx.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  const candidate = first[0];

  if (!candidate) throw new ThreadStoreError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);

  const owner = await tx
    .select({ id: thread.id })
    .from(thread)
    .where(eq(thread.id, candidate.threadId))
    .for("update")
    .limit(1);

  if (!owner[0]) throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);

  const rows = await tx
    .select()
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .for("update")
    .limit(1);

  if (!rows[0]) throw new ThreadStoreError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);

  return { workspace: rows[0], threadId: candidate.threadId };
}

export async function lockRunContext(
  tx: Tx,
  runId: string,
  lockWorkspace: boolean,
): Promise<{ current: RunRecord; workspace: WorkspaceRecord | null }> {
  const candidateRows = await tx
    .select({ threadId: run.threadId })
    .from(run)
    .where(eq(run.id, runId))
    .limit(1);

  const candidate = candidateRows[0];

  if (!candidate) throw new ThreadStoreError("RUN_NOT_FOUND", "Run not found", 404);

  const owner = await tx
    .select({ id: thread.id })
    .from(thread)
    .where(eq(thread.id, candidate.threadId))
    .for("update")
    .limit(1);

  if (!owner[0]) throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);
  let lockedWorkspace: WorkspaceRecord | null = null;

  if (lockWorkspace) {
    const workspaceRows = await tx
      .select()
      .from(workspace)
      .where(eq(workspace.threadId, candidate.threadId))
      .for("update")
      .limit(1);

    lockedWorkspace = workspaceRows[0] ?? null;
  }

  const lockedRuns = await tx.select().from(run).where(eq(run.id, runId)).for("update").limit(1);
  const current = lockedRuns[0];

  if (!current) throw new ThreadStoreError("RUN_NOT_FOUND", "Run not found", 404);

  return { current, workspace: lockedWorkspace };
}

export function assertExecutionOwnership(
  current: RunRecord,
  ownershipToken: string,
  attemptId: string,
  generation: number,
): void {
  if (
    !ownershipToken ||
    current.executionOwnerToken !== ownershipToken ||
    current.executionOwnerAttemptId !== attemptId ||
    current.executionOwnerGeneration !== generation
  )
    throw new ThreadStoreError(
      "CHECKPOINT_OWNERSHIP_LOST",
      "This execution attempt no longer owns the run",
      409,
    );
}

export async function cleanupBlockReason(
  tx: Tx,
  workspaceId: string,
  threadId: string,
  generation: number,
  waitingRunId?: string,
): Promise<"active-run" | "unsettled-command" | null> {
  const active = await tx
    .select({
      id: run.id,
      approvalWaitStartedAt: run.approvalWaitStartedAt,
      questionWaitStartedAt: run.questionWaitStartedAt,
    })
    .from(run)
    .where(and(eq(run.threadId, threadId), inArray(run.status, [...activeRunStatuses])))
    .limit(1);

  if (
    active[0] &&
    !(
      active[0].id === waitingRunId &&
      (active[0].approvalWaitStartedAt || active[0].questionWaitStartedAt)
    )
  )
    return "active-run";

  const unsettled = await tx
    .select({ commandId: commandOperation.commandId })
    .from(commandOperation)
    .where(
      and(
        eq(commandOperation.workspaceId, workspaceId),
        eq(commandOperation.generation, generation),
        inArray(commandOperation.state, [...unsettledCommandStates]),
      ),
    )
    .limit(1);

  if (unsettled[0]) return "unsettled-command";

  return null;
}
