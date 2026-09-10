import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import * as schema from "./schema";
import {
  agentCheckpoint,
  agentCheckpointEntry,
  commandOperation,
  message,
  outbox,
  run,
  thread,
  threadEvent,
  workspace,
} from "./schema/threads";
import {
  ThreadStoreError,
  WORKSPACE_RESET_INSTRUCTION,
  type CheckpointRecord,
  type CleanupProviderResult,
  type CleanupResult,
  type CommandBeginInput,
  type CommandOperationState,
  type CommandUpdateInput,
  type MessageInput,
  type RunRecord,
  type SubmitInput,
  type ThreadEvent,
  type ThreadStore,
  type ThreadView,
  type WorkspaceRecord,
} from "./thread-contracts";

type Db = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const activeRunStatuses = ["queued", "running"] as const;
const terminalRunStatuses = ["completed", "failed", "cancelled"] as const;
const unsettledCommandStates = ["pending", "running", "unknown"] as const;
const lifecycleLockKey = "cloud-swe:thread-admission:v1";

function isTerminalRun(status: string): boolean {
  return terminalRunStatuses.some((candidate) => candidate === status);
}

function isActiveRun(status: string): status is "queued" | "running" {
  return activeRunStatuses.some((candidate) => candidate === status);
}

function hasProperty(value: object, key: string): value is Record<string, unknown> {
  return key in value;
}

function postgresField(error: unknown, field: "code" | "constraint"): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    if (hasProperty(current, field)) {
      const value = current[field];
      if (typeof value === "string") return value;
    }
    if (!hasProperty(current, "cause")) return undefined;
    const cause = current.cause;
    if (cause === current) return undefined;
    current = cause;
  }
  return undefined;
}

function postgresConstraint(error: unknown): string | undefined {
  return postgresField(error, "constraint");
}

function isUniqueViolation(error: unknown): boolean {
  return postgresField(error, "code") === "23505";
}

function uniqueAdmissionError(error: unknown): ThreadStoreError | null {
  const constraint = postgresConstraint(error);
  if (constraint === "run_one_active_user_idx")
    return new ThreadStoreError("USER_BUSY", "The user already has an active run", 409);
  if (constraint === "run_one_active_thread_idx")
    return new ThreadStoreError("THREAD_BUSY", "This thread already has an active run", 409);
  return null;
}

function operationConflictError(error: unknown): ThreadStoreError | null {
  const constraint = postgresConstraint(error);
  if (constraint === "command_operation_unsettled_workspace_generation_idx")
    return new ThreadStoreError(
      "COMMAND_UNSETTLED",
      "The workspace generation already has an unsettled command operation",
      409,
    );
  return null;
}

function payloadNumber(payload: unknown, key: string): number | undefined {
  if (typeof payload !== "object" || payload === null || !hasProperty(payload, key))
    return undefined;
  const value = payload[key];
  return typeof value === "number" ? value : undefined;
}

const sessionContentSchema = z
  .object({ sessionId: z.string(), entries: z.array(z.unknown()) })
  .passthrough();
const storedSessionSchema = z.object({
  storage: z.literal("pi-session-entries-v1"),
  metadata: z.record(z.string(), z.unknown()),
  entryCount: z.number().int().nonnegative(),
});

export function createThreadStore(db: Db): ThreadStore {
  async function restoreCheckpoint(
    tx: Tx,
    checkpoint: CheckpointRecord | undefined,
  ): Promise<CheckpointRecord | null> {
    if (!checkpoint) return null;
    const stored = storedSessionSchema.safeParse(checkpoint.content);
    if (checkpoint.key !== "pi-session" || !stored.success) return checkpoint;
    const entries = await tx
      .select()
      .from(agentCheckpointEntry)
      .where(eq(agentCheckpointEntry.checkpointId, checkpoint.id))
      .orderBy(asc(agentCheckpointEntry.ordinal));
    if (
      entries.length !== stored.data.entryCount ||
      entries.some((entry, index) => entry.ordinal !== index)
    )
      throw new ThreadStoreError(
        "CHECKPOINT_INCOMPLETE",
        "Saved session entries are incomplete",
        500,
      );
    return {
      ...checkpoint,
      content: { ...stored.data.metadata, entries: entries.map((entry) => entry.content) },
    };
  }

  async function appendEvent(
    tx: Tx,
    threadId: string,
    type: string,
    payload: unknown,
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

  async function existingClientMessage(
    tx: Tx,
    input: SubmitInput,
    expectedThreadId?: string,
    expectedKind: "initial" | "followup" = expectedThreadId ? "followup" : "initial",
  ): Promise<{ threadId: string; runId: string } | null> {
    const rows = await tx
      .select({
        threadId: message.threadId,
        content: message.content,
        requestKind: message.requestKind,
        runId: message.runId,
        repositoryUrl: thread.repositoryUrl,
        repositoryBranch: thread.repositoryBranch,
      })
      .from(message)
      .innerJoin(thread, eq(message.threadId, thread.id))
      .where(
        and(eq(message.userId, input.userId), eq(message.clientMessageId, input.clientMessageId)),
      )
      .limit(1);
    const prior = rows[0];
    if (!prior) return null;

    const repositoryUrl =
      expectedKind === "initial" ? (input.repositoryUrl ?? null) : prior.repositoryUrl;
    const repositoryBranch =
      expectedKind === "initial" ? (input.repositoryBranch ?? null) : prior.repositoryBranch;
    if (
      prior.content !== input.prompt ||
      (expectedThreadId !== undefined && prior.threadId !== expectedThreadId) ||
      prior.requestKind !== expectedKind ||
      prior.repositoryUrl !== repositoryUrl ||
      prior.repositoryBranch !== repositoryBranch
    )
      throw new ThreadStoreError(
        "IDEMPOTENCY_CONFLICT",
        "clientMessageId was already used for a different request",
        409,
      );
    if (!prior.runId)
      throw new ThreadStoreError("IDEMPOTENCY_STATE", "The original request has no run", 500);
    const originalRun = await tx
      .select({ id: run.id })
      .from(run)
      .where(eq(run.id, prior.runId))
      .limit(1);
    if (!originalRun[0])
      throw new ThreadStoreError("IDEMPOTENCY_STATE", "The original request has no run", 500);
    return { threadId: prior.threadId, runId: originalRun[0].id };
  }

  async function ensureGlobalAdmission(tx: Tx, maxActiveRuns = 2): Promise<void> {
    const rows = await tx
      .select({ activeCount: sql<number>`count(*)` })
      .from(run)
      .where(inArray(run.status, [...activeRunStatuses]));
    const activeCount = Number(rows[0]?.activeCount ?? 0);
    if (activeCount >= maxActiveRuns)
      throw new ThreadStoreError("ACTIVE_RUN_LIMIT", "The active run limit has been reached", 429);
  }

  async function submit(
    input: SubmitInput,
    requestedThreadId?: string,
  ): Promise<{ threadId: string; runId: string }> {
    return db.transaction(async (tx) => {
      // Lock an existing thread before global admission so its cleanup cannot
      // stall submissions and cancellations for unrelated threads.
      if (requestedThreadId) {
        const owned = await tx
          .select({ id: thread.id })
          .from(thread)
          .where(and(eq(thread.id, requestedThreadId), eq(thread.userId, input.userId)))
          .for("update")
          .limit(1);
        if (!owned[0]) throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);
      }
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lifecycleLockKey}))`);
      const expectedKind = requestedThreadId ? "followup" : "initial";
      const prior = await existingClientMessage(tx, input, requestedThreadId, expectedKind);
      if (prior) return prior;
      await ensureGlobalAdmission(tx, input.maxActiveRuns ?? 2);

      let targetThreadId = requestedThreadId;
      if (!targetThreadId) {
        const created = await tx
          .insert(thread)
          .values({
            userId: input.userId,
            repositoryUrl: input.repositoryUrl ?? null,
            repositoryBranch: input.repositoryBranch ?? null,
          })
          .returning({ id: thread.id });
        const createdThread = created[0];
        if (!createdThread)
          throw new ThreadStoreError("CREATE_FAILED", "Could not create thread", 500);
        targetThreadId = createdThread.id;
      }

      let createdRun: RunRecord | undefined;
      try {
        const inserted = await tx
          .insert(run)
          .values({
            threadId: targetThreadId,
            userId: input.userId,
            status: "queued",
            prompt: input.prompt,
          })
          .returning();
        createdRun = inserted[0];
      } catch (error) {
        const mapped = isUniqueViolation(error) ? uniqueAdmissionError(error) : null;
        if (mapped) throw mapped;
        throw error;
      }
      if (!createdRun) throw new ThreadStoreError("CREATE_FAILED", "Could not create run", 500);

      const createdMessage = await tx
        .insert(message)
        .values({
          threadId: targetThreadId,
          runId: createdRun.id,
          userId: input.userId,
          role: "user",
          content: input.prompt,
          clientMessageId: input.clientMessageId,
          requestKind: expectedKind,
        })
        .returning({ id: message.id });
      const createdUserMessage = createdMessage[0];
      if (!createdUserMessage)
        throw new ThreadStoreError("CREATE_FAILED", "Could not create message", 500);

      await appendEvent(
        tx,
        targetThreadId,
        "run.queued",
        { runId: createdRun.id, messageId: createdUserMessage.id },
        `run:${createdRun.id}:queued`,
      );
      await tx.insert(outbox).values({
        type: "run.requested",
        threadId: targetThreadId,
        runId: createdRun.id,
        payload: { threadId: targetThreadId, runId: createdRun.id },
      });
      return { threadId: targetThreadId, runId: createdRun.id };
    });
  }

  async function readWorkspaceForThread(tx: Tx, threadId: string, lock: boolean) {
    const query = tx.select().from(workspace).where(eq(workspace.threadId, threadId)).limit(1);
    return lock ? query.for("update") : query;
  }

  async function lockThreadAndWorkspace(tx: Tx, threadId: string): Promise<WorkspaceRecord | null> {
    const owner = await tx
      .select({ id: thread.id })
      .from(thread)
      .where(eq(thread.id, threadId))
      .for("update")
      .limit(1);
    if (!owner[0]) throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);
    const rows = await readWorkspaceForThread(tx, threadId, true);
    return rows[0] ?? null;
  }

  async function lockWorkspaceContext(
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

  async function lockRunContext(
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

  async function cleanupBlockReason(
    tx: Tx,
    workspaceId: string,
    threadId: string,
    generation: number,
  ): Promise<"active-run" | "unsettled-command" | null> {
    const active = await tx
      .select({ id: run.id })
      .from(run)
      .where(and(eq(run.threadId, threadId), inArray(run.status, [...activeRunStatuses])))
      .limit(1);
    if (active[0]) return "active-run";
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

  async function finish(runId: string, status: "failed" | "cancelled", error?: string) {
    await db.transaction(async (tx) => {
      const { current } = await lockRunContext(tx, runId, false);
      if (isTerminalRun(current.status)) return;
      await tx
        .update(run)
        .set({ status, error: error ?? null, completedAt: new Date(), updatedAt: new Date() })
        .where(eq(run.id, runId));
      await appendEvent(
        tx,
        current.threadId,
        `run.${status}`,
        { runId, ...(error ? { error } : {}) },
        `run:${runId}:${status}`,
      );
    });
  }

  return {
    submitThread: (input) => submit(input),
    submitMessage: (input: MessageInput) => submit(input, input.threadId),

    async readRepository({ userId, threadId }) {
      const rows = await db
        .select({ repositoryUrl: thread.repositoryUrl, repositoryBranch: thread.repositoryBranch })
        .from(thread)
        .where(and(eq(thread.id, threadId), eq(thread.userId, userId)))
        .limit(1);
      if (!rows[0]) throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);
      return rows[0];
    },

    async listOtherUserWorkspaces({ userId, threadId }) {
      const rows = await db
        .select({ workspace })
        .from(workspace)
        .innerJoin(thread, eq(thread.id, workspace.threadId))
        .where(
          and(
            eq(thread.userId, userId),
            sql`${workspace.threadId} <> ${threadId}`,
            inArray(workspace.state, ["running", "provisioning", "recovery", "quarantined"]),
          ),
        );
      return rows.map((row) => row.workspace);
    },

    async getThread({ userId, threadId }) {
      return db.transaction(
        async (tx) => {
          const owned = await tx
            .select()
            .from(thread)
            .where(and(eq(thread.id, threadId), eq(thread.userId, userId)))
            .limit(1);
          const currentThread = owned[0];
          if (!currentThread)
            throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);
          const messages = await tx
            .select()
            .from(message)
            .where(eq(message.threadId, threadId))
            .orderBy(asc(message.createdAt));
          const runs = await tx
            .select()
            .from(run)
            .where(eq(run.threadId, threadId))
            .orderBy(asc(run.createdAt));
          const ws = await tx
            .select()
            .from(workspace)
            .where(eq(workspace.threadId, threadId))
            .limit(1);
          const ev = await tx
            .select({ sequence: threadEvent.sequence })
            .from(threadEvent)
            .where(eq(threadEvent.threadId, threadId))
            .orderBy(desc(threadEvent.sequence))
            .limit(1);
          const view: ThreadView = {
            id: currentThread.id,
            userId: currentThread.userId,
            title: currentThread.title,
            repositoryUrl: currentThread.repositoryUrl,
            repositoryBranch: currentThread.repositoryBranch,
            messages,
            runs,
            workspace: ws[0] ?? null,
            latestEventId: ev[0]?.sequence ?? null,
          };
          return view;
        },
        { isolationLevel: "repeatable read" },
      );
    },

    async authorizeThread({ userId, threadId }) {
      const owned = await db
        .select({ id: thread.id })
        .from(thread)
        .where(and(eq(thread.id, threadId), eq(thread.userId, userId)))
        .limit(1);
      if (!owned[0]) throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);
    },

    async listEvents({ threadId, after, limit = 100 }) {
      const rows = await db
        .select()
        .from(threadEvent)
        .where(
          after === undefined
            ? eq(threadEvent.threadId, threadId)
            : and(eq(threadEvent.threadId, threadId), gt(threadEvent.sequence, after)),
        )
        .orderBy(asc(threadEvent.sequence))
        .limit(Math.min(Math.max(limit, 1), 500));
      return rows;
    },

    async requestCancel({ userId, threadId, runId }) {
      return db.transaction(async (tx) => {
        const owner = await tx
          .select({ id: thread.id })
          .from(thread)
          .where(and(eq(thread.id, threadId), eq(thread.userId, userId)))
          .for("update")
          .limit(1);
        if (!owner[0]) throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);
        const rows = await tx
          .select()
          .from(run)
          .where(and(eq(run.id, runId), eq(run.threadId, threadId), eq(run.userId, userId)))
          .for("update")
          .limit(1);
        const current = rows[0];
        if (!current) throw new ThreadStoreError("RUN_NOT_FOUND", "Run not found", 404);
        if (isTerminalRun(current.status) || current.cancelRequestedAt) return;
        await tx
          .update(run)
          .set({ cancelRequestedAt: new Date(), updatedAt: new Date() })
          .where(eq(run.id, runId));
        await appendEvent(
          tx,
          threadId,
          "run.cancel_requested",
          { runId },
          `run:${runId}:cancel-requested`,
        );
        await tx.insert(outbox).values({
          type: "run.cancel",
          threadId,
          runId,
          payload: { threadId, runId },
        });
      });
    },

    async loadRun(runId: string): Promise<RunRecord | null> {
      const rows = await db.select().from(run).where(eq(run.id, runId)).limit(1);
      return rows[0] ?? null;
    },

    async startRun(runId) {
      await db.transaction(async (tx) => {
        const { current } = await lockRunContext(tx, runId, false);
        if (current.status !== "queued") return;
        await tx
          .update(run)
          .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
          .where(eq(run.id, runId));
        await appendEvent(tx, current.threadId, "run.started", { runId }, `run:${runId}:started`);
      });
    },

    async appendRunEvent({ runId, type, payload, dedupeKey }) {
      return db.transaction(async (tx) => {
        const { current } = await lockRunContext(tx, runId, false);
        if (isTerminalRun(current.status))
          throw new ThreadStoreError("RUN_TERMINAL", "Cannot append to a terminal run", 409);
        return appendEvent(tx, current.threadId, type, payload, dedupeKey);
      });
    },

    async saveCheckpoint({ runId, key, content, generation, attemptId }) {
      await db.transaction(async (tx) => {
        const { current, workspace: lockedWorkspace } = await lockRunContext(tx, runId, true);
        if (isTerminalRun(current.status))
          throw new ThreadStoreError(
            "RUN_TERMINAL",
            "Cannot write a checkpoint for a terminal run",
            409,
          );

        const currentGeneration = lockedWorkspace?.generation ?? 1;
        const effectiveGeneration = generation ?? currentGeneration;
        if (effectiveGeneration !== currentGeneration)
          throw new ThreadStoreError(
            "WORKSPACE_GENERATION_MISMATCH",
            "Checkpoint generation does not match the workspace",
            409,
          );
        const session = key === "pi-session" ? sessionContentSchema.safeParse(content) : null;
        const entries = session?.success ? session.data.entries : null;
        let storedContent = content;
        if (session?.success) {
          const { entries: _entries, ...metadata } = session.data;
          storedContent = {
            storage: "pi-session-entries-v1",
            metadata,
            entryCount: _entries.length,
          };
        }
        const checkpoints = await tx
          .insert(agentCheckpoint)
          .values({
            runId,
            key,
            generation: effectiveGeneration,
            attemptId,
            content: storedContent,
          })
          .onConflictDoUpdate({
            target: [agentCheckpoint.runId, agentCheckpoint.key],
            set: {
              generation: effectiveGeneration,
              attemptId,
              content: storedContent,
              createdAt: new Date(),
            },
          })
          .returning({ id: agentCheckpoint.id });
        const checkpoint = checkpoints[0];
        if (!checkpoint)
          throw new ThreadStoreError("CHECKPOINT_CREATE_FAILED", "Could not save checkpoint", 500);
        if (entries !== null) {
          // Entries are append-only in normal Pi turns. Keep unchanged rows intact;
          // session replacement or compaction can also update a prefix and trim a tail.
          for (let start = 0; start < entries.length; start += 500) {
            await tx
              .insert(agentCheckpointEntry)
              .values(
                entries.slice(start, start + 500).map((entry, index) => ({
                  checkpointId: checkpoint.id,
                  ordinal: start + index,
                  content: entry,
                })),
              )
              .onConflictDoUpdate({
                target: [agentCheckpointEntry.checkpointId, agentCheckpointEntry.ordinal],
                set: { content: sql`excluded.content` },
                setWhere: sql`${agentCheckpointEntry.content} is distinct from excluded.content`,
              });
          }
        }
        await tx
          .delete(agentCheckpointEntry)
          .where(
            and(
              eq(agentCheckpointEntry.checkpointId, checkpoint.id),
              gt(agentCheckpointEntry.ordinal, (entries?.length ?? 0) - 1),
            ),
          );
      });
    },

    async loadCheckpoint({ runId, key, generation }) {
      return db.transaction(
        async (tx) => {
          const predicates = [eq(agentCheckpoint.runId, runId), eq(agentCheckpoint.key, key)];
          if (generation !== undefined) predicates.push(eq(agentCheckpoint.generation, generation));
          const rows = await tx
            .select()
            .from(agentCheckpoint)
            .where(and(...predicates))
            .limit(1);
          return restoreCheckpoint(tx, rows[0]);
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    async loadLatestCheckpoint({ threadId, key, generation }) {
      return db.transaction(
        async (tx) => {
          const predicates = [eq(run.threadId, threadId), eq(agentCheckpoint.key, key)];
          if (generation !== undefined) predicates.push(eq(agentCheckpoint.generation, generation));
          const rows = await tx
            .select({ checkpoint: agentCheckpoint })
            .from(agentCheckpoint)
            .innerJoin(run, eq(agentCheckpoint.runId, run.id))
            .where(and(...predicates))
            .orderBy(desc(agentCheckpoint.createdAt))
            .limit(1);
          return restoreCheckpoint(tx, rows[0]?.checkpoint);
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    async completeRun(runId, assistantContent) {
      await db.transaction(async (tx) => {
        const { current } = await lockRunContext(tx, runId, false);
        if (isTerminalRun(current.status)) return;
        if (current.cancelRequestedAt) {
          await tx
            .update(run)
            .set({ status: "cancelled", completedAt: new Date(), updatedAt: new Date() })
            .where(eq(run.id, runId));
          await appendEvent(
            tx,
            current.threadId,
            "run.cancelled",
            { runId },
            `run:${runId}:cancelled`,
          );
          return;
        }
        if (assistantContent)
          await tx.insert(message).values({
            threadId: current.threadId,
            userId: current.userId,
            role: "assistant",
            content: assistantContent,
            runId,
          });
        await tx
          .update(run)
          .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
          .where(eq(run.id, runId));
        await appendEvent(
          tx,
          current.threadId,
          "run.completed",
          { runId },
          `run:${runId}:completed`,
        );
      });
    },

    async failRun(runId, error) {
      await finish(runId, "failed", error);
    },

    async cancelRun(runId) {
      await finish(runId, "cancelled");
    },

    async updateWorkspace({
      threadId,
      state,
      provider,
      providerId,
      name,
      generation,
      lifecycleTransitionId,
    }) {
      return db.transaction(async (tx) => {
        const current = await lockThreadAndWorkspace(tx, threadId);
        const now = new Date();
        if (!current) {
          if (!provider)
            throw new ThreadStoreError(
              "WORKSPACE_PROVIDER_REQUIRED",
              "Creating a workspace requires its provider",
              400,
            );
          const transitionId = lifecycleTransitionId ?? randomUUID();
          const inserted = await tx
            .insert(workspace)
            .values({
              threadId,
              name: name ?? `cloud-swe-${threadId}`,
              state,
              provider,
              providerId,
              generation: generation ?? 1,
              lifecycleTransitionId: null,
              lifecycleTransitionState: null,
              updatedAt: now,
            })
            .returning();
          const created = inserted[0];
          if (!created)
            throw new ThreadStoreError("CREATE_FAILED", "Could not create workspace", 500);
          await appendEvent(
            tx,
            threadId,
            `workspace.${state}`,
            { threadId, state, generation: created.generation, transitionId },
            `workspace:${threadId}:transition:${transitionId}`,
          );
          return created;
        }

        if (generation !== undefined && generation !== current.generation)
          throw new ThreadStoreError(
            "WORKSPACE_GENERATION_MISMATCH",
            "Workspace generation does not match the stored workspace",
            409,
          );
        if (current.lifecycleTransitionId) {
          if (lifecycleTransitionId && current.lifecycleTransitionId !== lifecycleTransitionId)
            throw new ThreadStoreError(
              "LIFECYCLE_TRANSITION_CONFLICT",
              "The workspace lifecycle transition belongs to another attempt",
              409,
            );
          if (current.lifecycleTransitionState && current.lifecycleTransitionState !== state)
            throw new ThreadStoreError(
              "LIFECYCLE_TRANSITION_CONFLICT",
              "The pending lifecycle transition has a different target state",
              409,
            );
        }

        const changedState = current.state !== state;
        const transitionId =
          lifecycleTransitionId ??
          current.lifecycleTransitionId ??
          (changedState ? randomUUID() : undefined);
        const updates = {
          state,
          ...(provider !== undefined ? { provider } : {}),
          ...(providerId !== undefined ? { providerId } : {}),
          ...(name !== undefined ? { name } : {}),
          ...(generation !== undefined ? { generation } : {}),
          lifecycleTransitionId: null,
          lifecycleTransitionState: null,
          updatedAt: now,
        };
        await tx.update(workspace).set(updates).where(eq(workspace.id, current.id));
        if (changedState) {
          if (!transitionId)
            throw new ThreadStoreError(
              "LIFECYCLE_TRANSITION_REQUIRED",
              "A workspace state transition needs a durable transition ID",
              409,
            );
          await appendEvent(
            tx,
            threadId,
            `workspace.${state}`,
            { threadId, state, generation: current.generation, transitionId },
            `workspace:${threadId}:transition:${transitionId}`,
          );
        }
        const updated = await tx
          .select()
          .from(workspace)
          .where(eq(workspace.id, current.id))
          .limit(1);
        if (!updated[0])
          throw new ThreadStoreError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
        return updated[0];
      });
    },

    async readWorkspace(threadId) {
      const rows = await db
        .select()
        .from(workspace)
        .where(eq(workspace.threadId, threadId))
        .limit(1);
      return rows[0] ?? null;
    },

    async persistRecoveredProviderId({ workspaceId, providerId }) {
      return db.transaction(async (tx) => {
        const locked = await lockWorkspaceContext(tx, workspaceId);
        await tx
          .update(workspace)
          .set({ providerId, updatedAt: new Date() })
          .where(eq(workspace.id, workspaceId));
        const updated = await tx
          .select()
          .from(workspace)
          .where(eq(workspace.id, workspaceId))
          .limit(1);
        if (!updated[0])
          throw new ThreadStoreError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
        return updated[0] ?? locked.workspace;
      });
    },

    async resetWorkspace({
      threadId,
      expectedGeneration,
      confirmedMissing,
      reason,
      transitionId,
      providerId,
      state = "recovery",
    }) {
      if (!confirmedMissing)
        throw new ThreadStoreError(
          "RESET_NOT_CONFIRMED",
          "A workspace reset requires provider confirmation that the old filesystem is missing",
          409,
        );
      return db.transaction(async (tx) => {
        const current = await lockThreadAndWorkspace(tx, threadId);
        const now = new Date();
        if (!current)
          throw new ThreadStoreError(
            "WORKSPACE_NOT_FOUND",
            "Cannot reset a missing workspace",
            404,
          );
        const oldGeneration = current.generation;
        if (oldGeneration !== expectedGeneration) {
          const alreadyAppliedGeneration = expectedGeneration + 1;
          if (oldGeneration !== alreadyAppliedGeneration)
            throw new ThreadStoreError(
              "WORKSPACE_GENERATION_MISMATCH",
              "Workspace generation changed before the reset could be applied",
              409,
            );
          const appliedCandidates = await tx
            .select()
            .from(threadEvent)
            .where(and(eq(threadEvent.threadId, threadId), eq(threadEvent.type, "workspace.reset")))
            .orderBy(desc(threadEvent.sequence))
            .limit(20);
          const applied = appliedCandidates.find(
            (event) =>
              payloadNumber(event.payload, "oldGeneration") === expectedGeneration &&
              payloadNumber(event.payload, "newGeneration") === alreadyAppliedGeneration,
          );
          if (!applied)
            throw new ThreadStoreError(
              "RESET_STATE_UNKNOWN",
              "The workspace generation advanced but its reset event is missing",
              500,
            );
          return {
            workspace: current,
            oldGeneration: expectedGeneration,
            newGeneration: current.generation,
            event: applied,
            alreadyApplied: true,
          };
        }

        const olderOperations = await tx
          .select({ commandId: commandOperation.commandId, state: commandOperation.state })
          .from(commandOperation)
          .where(
            and(
              eq(commandOperation.workspaceId, current.id),
              lte(commandOperation.generation, expectedGeneration),
              inArray(commandOperation.state, [...unsettledCommandStates]),
            ),
          );
        const unsettledOlderOperations = olderOperations.length;
        if (olderOperations.length > 0)
          await tx
            .update(commandOperation)
            .set({
              state: "unknown",
              result: {
                kind: "workspace-reset",
                reason: "The provider confirmed that the old filesystem is missing",
              },
              updatedAt: now,
            })
            .where(
              and(
                eq(commandOperation.workspaceId, current.id),
                lte(commandOperation.generation, expectedGeneration),
                inArray(commandOperation.state, ["pending", "running"]),
              ),
            );
        const newGeneration = expectedGeneration + 1;
        const dedupeKey = transitionId
          ? `workspace:${threadId}:reset:${transitionId}`
          : `workspace:${threadId}:reset:${newGeneration}`;
        const workspaceId = current.id;
        const updated = await tx
          .update(workspace)
          .set({
            state,
            ...(providerId !== undefined ? { providerId } : { providerId: null }),
            generation: newGeneration,
            lifecycleTransitionId: null,
            lifecycleTransitionState: null,
            updatedAt: now,
          })
          .where(eq(workspace.id, current.id))
          .returning();
        const next = updated[0];
        if (!next) throw new ThreadStoreError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);

        const event = await appendEvent(
          tx,
          threadId,
          "workspace.reset",
          {
            threadId,
            workspaceId,
            oldGeneration: expectedGeneration,
            newGeneration,
            reason,
            resetTransitionId: transitionId ?? null,
            unsettledOlderOperations,
            confirmedMissing,
            message: WORKSPACE_RESET_INSTRUCTION,
          },
          dedupeKey,
        );
        return {
          workspace: next,
          oldGeneration: expectedGeneration,
          newGeneration,
          event,
          alreadyApplied: false,
        };
      });
    },

    async beginLifecycleTransition({ threadId, transitionId, state }) {
      return db.transaction(async (tx) => {
        const current = await lockThreadAndWorkspace(tx, threadId);
        if (!current) throw new ThreadStoreError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
        if (current.lifecycleTransitionId) {
          if (transitionId && current.lifecycleTransitionId !== transitionId)
            throw new ThreadStoreError(
              "LIFECYCLE_TRANSITION_CONFLICT",
              "A different lifecycle transition is already pending",
              409,
            );
          if (current.lifecycleTransitionState && current.lifecycleTransitionState !== state)
            throw new ThreadStoreError(
              "LIFECYCLE_TRANSITION_CONFLICT",
              "The pending lifecycle transition has a different target state",
              409,
            );
          return { transitionId: current.lifecycleTransitionId, workspace: current };
        }
        const nextTransitionId = transitionId ?? randomUUID();
        const updated = await tx
          .update(workspace)
          .set({
            lifecycleTransitionId: nextTransitionId,
            lifecycleTransitionState: state,
            updatedAt: new Date(),
          })
          .where(eq(workspace.id, current.id))
          .returning();
        const next = updated[0];
        if (!next) throw new ThreadStoreError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
        return { transitionId: nextTransitionId, workspace: next };
      });
    },

    async cancelLifecycleTransition({ threadId, transitionId }) {
      return db.transaction(async (tx) => {
        const current = await lockThreadAndWorkspace(tx, threadId);
        if (!current) throw new ThreadStoreError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
        if (current.lifecycleTransitionId !== transitionId)
          throw new ThreadStoreError(
            "LIFECYCLE_TRANSITION_CONFLICT",
            "The lifecycle transition is not pending on this workspace",
            409,
          );
        const updated = await tx
          .update(workspace)
          .set({
            lifecycleTransitionId: null,
            lifecycleTransitionState: null,
            updatedAt: new Date(),
          })
          .where(eq(workspace.id, current.id))
          .returning();
        const next = updated[0];
        if (!next) throw new ThreadStoreError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
        return next;
      });
    },

    async cleanupWorkspace({ threadId, transitionId: requestedTransitionId, targetState, mutate }) {
      let transitionId = requestedTransitionId;
      if (!transitionId) {
        const begun = await this.beginLifecycleTransition({ threadId, state: targetState });
        transitionId = begun.transitionId;
      }

      return db.transaction(async (tx): Promise<CleanupResult> => {
        const current = await lockThreadAndWorkspace(tx, threadId);
        if (!current) throw new ThreadStoreError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
        if (current.lifecycleTransitionId !== transitionId) {
          if (current.lifecycleTransitionId === null && current.state === targetState)
            return { outcome: "completed", transitionId, workspace: current };
          throw new ThreadStoreError(
            "LIFECYCLE_TRANSITION_CONFLICT",
            "The lifecycle transition is not pending on this workspace",
            409,
          );
        }

        const blocked = await cleanupBlockReason(tx, current.id, threadId, current.generation);
        if (blocked)
          return { outcome: "deferred", reason: blocked, transitionId, workspace: current };

        // The thread lock excludes new runs until the provider outcome is recorded.
        let providerResult: CleanupProviderResult;
        try {
          providerResult = await mutate(current);
        } catch {
          providerResult = { outcome: "unknown" };
        }
        if (providerResult.outcome === "unknown")
          return { outcome: "unknown", transitionId, workspace: current };

        const missing = providerResult.outcome === "missing";
        const nextState = missing ? "deleted" : targetState;
        const nextProviderId =
          nextState === "deleted"
            ? null
            : providerResult.providerId !== undefined
              ? providerResult.providerId
              : current.providerId;
        await tx
          .update(workspace)
          .set({
            state: nextState,
            providerId: nextProviderId,
            lifecycleTransitionId: null,
            lifecycleTransitionState: null,
            updatedAt: new Date(),
          })
          .where(eq(workspace.id, current.id));
        await appendEvent(
          tx,
          threadId,
          `workspace.${nextState}`,
          {
            threadId,
            state: nextState,
            generation: current.generation,
            transitionId,
            confirmedMissing: missing,
          },
          `workspace:${threadId}:transition:${transitionId}`,
        );
        const updated = await tx
          .select()
          .from(workspace)
          .where(eq(workspace.id, current.id))
          .limit(1);
        if (!updated[0])
          throw new ThreadStoreError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
        return { outcome: missing ? "missing" : "completed", transitionId, workspace: updated[0] };
      });
    },

    async beginCommand(input: CommandBeginInput) {
      return db.transaction(async (tx) => {
        const context = await lockWorkspaceContext(tx, input.workspaceId);
        if (context.workspace.generation !== input.generation)
          throw new ThreadStoreError(
            "WORKSPACE_GENERATION_MISMATCH",
            "Command generation does not match the workspace",
            409,
          );
        if (
          ["paused", "quarantined", "recovery", "deleted", "failed"].includes(
            context.workspace.state,
          )
        )
          throw new ThreadStoreError(
            "WORKSPACE_UNAVAILABLE",
            "Commands cannot start while the workspace requires recovery",
            409,
          );
        if (context.workspace.lifecycleTransitionId)
          throw new ThreadStoreError(
            "LIFECYCLE_TRANSITION_PENDING",
            "Commands cannot start while a workspace lifecycle transition is pending",
            409,
          );
        if (input.attemptId.length === 0)
          throw new ThreadStoreError(
            "COMMAND_ATTEMPT_REQUIRED",
            "Command attemptId is required",
            400,
          );

        const runRows = await tx
          .select()
          .from(run)
          .where(and(eq(run.id, input.runId), eq(run.threadId, context.threadId)))
          .for("update")
          .limit(1);
        const currentRun = runRows[0];
        if (!currentRun)
          throw new ThreadStoreError(
            "COMMAND_OWNERSHIP_CONFLICT",
            "Command run does not belong to the workspace thread",
            409,
          );

        if (input.commandId) {
          const existingRows = await tx
            .select()
            .from(commandOperation)
            .where(eq(commandOperation.commandId, input.commandId))
            .for("update")
            .limit(1);
          const existing = existingRows[0];
          if (existing) {
            if (
              existing.workspaceId !== input.workspaceId ||
              existing.generation !== input.generation ||
              existing.runId !== input.runId ||
              existing.attemptId !== input.attemptId
            )
              throw new ThreadStoreError(
                "COMMAND_OWNERSHIP_CONFLICT",
                "commandId is owned by a different workspace, generation, run, or attempt",
                409,
              );
            if (!isActiveRun(currentRun.status)) {
              if (isTerminalCommand(existing.state)) return existing;
              throw new ThreadStoreError(
                "RUN_TERMINAL",
                "Cannot resume a command for a non-active run",
                409,
              );
            }
            return existing;
          }
        }
        if (!isActiveRun(currentRun.status))
          throw new ThreadStoreError(
            isTerminalRun(currentRun.status) ? "RUN_TERMINAL" : "RUN_NOT_ACTIVE",
            "Commands require an active run",
            409,
          );

        try {
          const inserted = await tx
            .insert(commandOperation)
            .values({
              commandId: input.commandId,
              workspaceId: input.workspaceId,
              generation: input.generation,
              runId: input.runId,
              attemptId: input.attemptId,
              metadata: input.metadata,
              state: "pending",
            })
            .returning();
          const operation = inserted[0];
          if (!operation)
            throw new ThreadStoreError(
              "COMMAND_CREATE_FAILED",
              "Could not create command operation",
              500,
            );
          return operation;
        } catch (error) {
          const mapped = isUniqueViolation(error) ? operationConflictError(error) : null;
          if (mapped) throw mapped;
          throw error;
        }
      });
    },

    async readCommand(commandId) {
      const rows = await db
        .select()
        .from(commandOperation)
        .where(eq(commandOperation.commandId, commandId))
        .limit(1);
      return rows[0] ?? null;
    },

    async listUnsettledCommands({ workspaceId, generation }) {
      const predicates = [
        eq(commandOperation.workspaceId, workspaceId),
        inArray(commandOperation.state, [...unsettledCommandStates]),
      ];
      if (generation !== undefined) predicates.push(eq(commandOperation.generation, generation));
      return db
        .select()
        .from(commandOperation)
        .where(and(...predicates))
        .orderBy(asc(commandOperation.createdAt));
    },

    async updateCommand({
      commandId,
      state,
      cancellationRequested,
      metadata,
      result,
    }: CommandUpdateInput) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(commandOperation)
          .where(eq(commandOperation.commandId, commandId))
          .for("update")
          .limit(1);
        const current = rows[0];
        if (!current)
          throw new ThreadStoreError("COMMAND_NOT_FOUND", "Command operation not found", 404);
        if (state && isTerminalCommand(current.state) && state !== current.state)
          throw new ThreadStoreError(
            "COMMAND_TERMINAL",
            "A terminal command operation cannot change state",
            409,
          );

        const now = new Date();
        const updates: {
          state?: CommandOperationState;
          cancellationRequested?: boolean;
          metadata?: unknown;
          result?: unknown;
          startedAt?: Date;
          completedAt?: Date | null;
          updatedAt: Date;
        } = { updatedAt: now };
        if (state) updates.state = state;
        if (cancellationRequested !== undefined)
          updates.cancellationRequested = cancellationRequested;
        if (metadata !== undefined) updates.metadata = metadata;
        if (result !== undefined) updates.result = result;
        if (state === "running" && !current.startedAt) updates.startedAt = now;
        if (state && isTerminalCommand(state)) updates.completedAt = current.completedAt ?? now;
        await tx
          .update(commandOperation)
          .set(updates)
          .where(eq(commandOperation.commandId, commandId));
        const updated = await tx
          .select()
          .from(commandOperation)
          .where(eq(commandOperation.commandId, commandId))
          .limit(1);
        if (!updated[0])
          throw new ThreadStoreError("COMMAND_NOT_FOUND", "Command operation not found", 404);
        return updated[0];
      });
    },

    async listPendingOutbox(limit = 100) {
      return db
        .select()
        .from(outbox)
        .where(and(isNull(outbox.deliveredAt), lt(outbox.availableAt, new Date())))
        .orderBy(asc(outbox.createdAt))
        .limit(limit);
    },

    async markDelivered(id) {
      await db.update(outbox).set({ deliveredAt: new Date() }).where(eq(outbox.id, id));
    },

    async recordFailure(id, error, retryAt = new Date(Date.now() + 1000)) {
      await db
        .update(outbox)
        .set({ attempts: sql`${outbox.attempts} + 1`, lastError: error, availableAt: retryAt })
        .where(eq(outbox.id, id));
    },
  };
}

function isTerminalCommand(state: string): boolean {
  return state === "completed" || state === "failed";
}
