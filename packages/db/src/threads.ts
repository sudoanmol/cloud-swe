import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { randomUUID } from "node:crypto";
import * as schema from "./schema";
import {
  agentCheckpoint,
  message,
  outbox,
  run,
  thread,
  threadEvent,
  workspace,
} from "./schema/threads";
import {
  ThreadStoreError,
  type MessageInput,
  type SubmitInput,
  type ThreadEvent,
  type ThreadStore,
  type ThreadView,
  type RunRecord,
  type CheckpointRecord,
} from "./thread-contracts";

type Db = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const active = ["queued", "running"] as const;
const terminal = ["completed", "failed", "cancelled"] as const;
const lockKey = "cloud-swe:thread-admission:v1";

export function createThreadStore(db: Db): ThreadStore {
  async function admission<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
      return fn(tx);
    });
  }
  async function ensureAdmission(tx: Tx, userId: string, threadId?: string, maxActiveRuns = 2) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`user:${userId}`}))`);
    const globalRows = await tx
      .select({ id: run.id })
      .from(run)
      .where(inArray(run.status, [...active]));
    if (globalRows.length >= maxActiveRuns)
      throw new ThreadStoreError("ACTIVE_RUN_LIMIT", "The active run limit has been reached", 429);
    const rows = await tx
      .select({ id: run.id })
      .from(run)
      .where(and(eq(run.userId, userId), inArray(run.status, [...active])));
    if (rows.length > 0)
      throw new ThreadStoreError("USER_BUSY", "The user already has an active run", 409);
    if (threadId) {
      const existing = await tx
        .select({ id: run.id })
        .from(run)
        .where(and(eq(run.threadId, threadId), inArray(run.status, [...active])))
        .limit(1);
      if (existing.length)
        throw new ThreadStoreError("THREAD_BUSY", "This thread already has an active run", 409);
    }
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
      })
      .from(message)
      .where(
        and(eq(message.userId, input.userId), eq(message.clientMessageId, input.clientMessageId)),
      )
      .limit(1);
    if (!rows[0]) return null;
    if (
      rows[0].content !== input.prompt ||
      (expectedThreadId !== undefined && rows[0].threadId !== expectedThreadId) ||
      rows[0].requestKind !== expectedKind
    )
      throw new ThreadStoreError(
        "IDEMPOTENCY_CONFLICT",
        "clientMessageId was already used for a different request",
        409,
      );
    const r = await tx
      .select({ id: run.id })
      .from(run)
      .where(eq(run.id, rows[0].runId ?? "00000000-0000-0000-0000-000000000000"))
      .limit(1);
    if (!r[0])
      throw new ThreadStoreError("IDEMPOTENCY_STATE", "The original request has no run", 500);
    return { threadId: rows[0].threadId, runId: r[0].id };
  }
  async function submit(
    input: SubmitInput,
    threadId?: string,
  ): Promise<{ threadId: string; runId: string }> {
    return admission(async (tx) => {
      const prior = await existingClientMessage(
        tx,
        input,
        threadId,
        threadId ? "followup" : "initial",
      );
      if (prior) return prior;
      await ensureAdmission(tx, input.userId, threadId, input.maxActiveRuns);
      let target = threadId;
      if (target) {
        const owned = await tx
          .select({ id: thread.id })
          .from(thread)
          .where(and(eq(thread.id, target), eq(thread.userId, input.userId)))
          .limit(1);
        if (!owned[0]) throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);
      } else {
        const created = await tx
          .insert(thread)
          .values({ userId: input.userId })
          .returning({ id: thread.id });
        const createdThread = created[0];
        if (!createdThread)
          throw new ThreadStoreError("CREATE_FAILED", "Could not create thread", 500);
        target = createdThread.id;
      }
      const createdMessage = await tx
        .insert(message)
        .values({
          threadId: target,
          runId: null,
          userId: input.userId,
          role: "user",
          content: input.prompt,
          clientMessageId: input.clientMessageId,
          requestKind: threadId ? "followup" : "initial",
        })
        .returning({ id: message.id });
      const createdRun = await tx
        .insert(run)
        .values({ threadId: target, userId: input.userId, status: "queued", prompt: input.prompt })
        .returning({ id: run.id });
      const createdUserMessage = createdMessage[0];
      const createdAgentRun = createdRun[0];
      if (!createdUserMessage || !createdAgentRun)
        throw new ThreadStoreError("CREATE_FAILED", "Could not create run", 500);
      await tx
        .update(message)
        .set({ runId: createdAgentRun.id })
        .where(eq(message.id, createdUserMessage.id));
      await appendEvent(
        tx,
        target,
        "run.queued",
        { runId: createdAgentRun.id, messageId: createdUserMessage.id },
        `run:${createdAgentRun.id}:queued`,
      );
      await tx.insert(outbox).values({
        type: "run.requested",
        threadId: target,
        runId: createdAgentRun.id,
        payload: { threadId: target, runId: createdAgentRun.id },
      });
      return { threadId: target, runId: createdAgentRun.id };
    });
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
  async function runRow(runId: string): Promise<RunRecord | null> {
    const rows = await db.select().from(run).where(eq(run.id, runId)).limit(1);
    return rows[0] ?? null;
  }
  return {
    submitThread: (input) => submit(input),
    submitMessage: (input: MessageInput) => submit(input, input.threadId),
    async getThread({ userId, threadId }) {
      return db.transaction(
        async (tx) => {
          const t = await tx
            .select()
            .from(thread)
            .where(and(eq(thread.id, threadId), eq(thread.userId, userId)))
            .limit(1);
          if (!t[0]) throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);
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
            id: t[0].id,
            userId: t[0].userId,
            title: t[0].title,
            messages,
            runs,
            workspace: ws[0] ?? null,
            latestEventId: ev[0] ? String(ev[0].sequence) : null,
          };
          return view;
        },
        { isolationLevel: "repeatable read" },
      );
    },
    async listEvents({ userId, threadId, after, limit = 100 }) {
      const owned = await db
        .select({ id: thread.id })
        .from(thread)
        .where(and(eq(thread.id, threadId), eq(thread.userId, userId)))
        .limit(1);
      if (!owned[0]) throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);
      const rows = await db
        .select()
        .from(threadEvent)
        .where(
          after
            ? and(eq(threadEvent.threadId, threadId), gt(threadEvent.sequence, Number(after)))
            : eq(threadEvent.threadId, threadId),
        )
        .orderBy(asc(threadEvent.sequence))
        .limit(Math.min(limit, 500));
      return rows;
    },
    async requestCancel({ userId, threadId, runId }) {
      return admission(async (tx) => {
        const rows = await tx
          .select()
          .from(run)
          .where(and(eq(run.id, runId), eq(run.threadId, threadId), eq(run.userId, userId)))
          .for("update")
          .limit(1);
        const current = rows[0];
        if (!current) throw new ThreadStoreError("RUN_NOT_FOUND", "Run not found", 404);
        if ((terminal as readonly string[]).includes(current.status) || current.cancelRequestedAt)
          return;
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
        await tx
          .insert(outbox)
          .values({ type: "run.cancel", threadId, runId, payload: { threadId, runId } });
      });
    },
    inspectRun: runRow,
    loadRun: runRow,
    async startRun(runId) {
      await db.transaction(async (tx) => {
        const rows = await tx.select().from(run).where(eq(run.id, runId)).for("update");
        const r = rows[0];
        if (!r || r.status !== "queued") return;
        await tx
          .update(run)
          .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
          .where(eq(run.id, runId));
        await appendEvent(tx, r.threadId, "run.started", { runId }, `run:${runId}:started`);
      });
    },
    async appendRunEvent({ runId, type, payload, dedupeKey }) {
      return db.transaction(async (tx) => {
        const r = await tx
          .select({ threadId: run.threadId, status: run.status })
          .from(run)
          .where(eq(run.id, runId))
          .for("update")
          .limit(1);
        if (!r[0]) throw new ThreadStoreError("RUN_NOT_FOUND", "Run not found", 404);
        if ((terminal as readonly string[]).includes(r[0].status))
          throw new ThreadStoreError("RUN_TERMINAL", "Cannot append to a terminal run", 409);
        return appendEvent(tx, r[0].threadId, type, payload, dedupeKey);
      });
    },
    async saveCheckpoint({ runId, step, content }) {
      await db.transaction(async (tx) => {
        const current = await tx
          .select({ status: run.status })
          .from(run)
          .where(eq(run.id, runId))
          .for("update")
          .limit(1);
        if (!current[0]) throw new ThreadStoreError("RUN_NOT_FOUND", "Run not found", 404);
        if ((terminal as readonly string[]).includes(current[0].status)) return;
        await tx
          .insert(agentCheckpoint)
          .values({ runId, step, content })
          .onConflictDoUpdate({
            target: [agentCheckpoint.runId, agentCheckpoint.step],
            set: { content, createdAt: new Date() },
          });
      });
    },
    async loadCheckpoint({ runId, step }): Promise<CheckpointRecord | null> {
      const rows = await db
        .select()
        .from(agentCheckpoint)
        .where(and(eq(agentCheckpoint.runId, runId), eq(agentCheckpoint.step, step)))
        .limit(1);
      return rows[0] ?? null;
    },
    async loadLatestCheckpoint({ threadId, step }): Promise<CheckpointRecord | null> {
      const rows = await db
        .select({ checkpoint: agentCheckpoint })
        .from(agentCheckpoint)
        .innerJoin(run, eq(agentCheckpoint.runId, run.id))
        .where(and(eq(run.threadId, threadId), eq(agentCheckpoint.step, step)))
        .orderBy(desc(agentCheckpoint.createdAt))
        .limit(1);
      return rows[0]?.checkpoint ?? null;
    },
    async completeRun(runId, assistantContent) {
      await db.transaction(async (tx) => {
        const rows = await tx.select().from(run).where(eq(run.id, runId)).for("update");
        const r = rows[0];
        if (!r || (terminal as readonly string[]).includes(r.status)) return;
        if (r.cancelRequestedAt) {
          await tx
            .update(run)
            .set({ status: "cancelled", completedAt: new Date(), updatedAt: new Date() })
            .where(eq(run.id, runId));
          await appendEvent(tx, r.threadId, "run.cancelled", { runId }, `run:${runId}:cancelled`);
          return;
        }
        if (assistantContent)
          await tx.insert(message).values({
            threadId: r.threadId,
            userId: r.userId,
            role: "assistant",
            content: assistantContent,
            runId,
          });
        await tx
          .update(run)
          .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
          .where(eq(run.id, runId));
        await appendEvent(tx, r.threadId, "run.completed", { runId }, `run:${runId}:completed`);
      });
    },
    async failRun(runId, error) {
      await finish(runId, "failed", error);
    },
    async cancelRun(runId) {
      await finish(runId, "cancelled");
    },
    async updateWorkspace({ threadId, state, provider, providerId }) {
      await db.transaction(async (tx) => {
        const owner = await tx
          .select({ id: thread.id })
          .from(thread)
          .where(eq(thread.id, threadId))
          .for("update")
          .limit(1);
        if (!owner[0]) throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);
        const current = await tx
          .select()
          .from(workspace)
          .where(eq(workspace.threadId, threadId))
          .for("update")
          .limit(1);
        if (current[0]?.state === state) {
          const updates = {
            ...(providerId !== undefined ? { providerId } : {}),
            ...(provider !== undefined ? { provider } : {}),
            updatedAt: new Date(),
          };
          await tx.update(workspace).set(updates).where(eq(workspace.threadId, threadId));
          return;
        }
        const updates = {
          state,
          ...(providerId !== undefined ? { providerId } : {}),
          ...(provider !== undefined ? { provider } : {}),
          updatedAt: new Date(),
        };
        await tx
          .insert(workspace)
          .values({
            threadId,
            dockerName: `cloud-swe-${threadId}`,
            state,
            provider: provider ?? "docker",
            providerId,
          })
          .onConflictDoUpdate({
            target: workspace.threadId,
            set: updates,
          });
        await appendEvent(
          tx,
          threadId,
          `workspace.${state}`,
          { threadId, state },
          `workspace:${threadId}:transition:${randomUUID()}`,
        );
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
  async function finish(runId: string, status: "failed" | "cancelled", error?: string) {
    await db.transaction(async (tx) => {
      const rows = await tx.select().from(run).where(eq(run.id, runId)).for("update");
      const r = rows[0];
      if (!r || (terminal as readonly string[]).includes(r.status)) return;
      await tx
        .update(run)
        .set({ status, error: error ?? null, completedAt: new Date(), updatedAt: new Date() })
        .where(eq(run.id, runId));
      await appendEvent(
        tx,
        r.threadId,
        `run.${status}`,
        { runId, ...(error ? { error } : {}) },
        `run:${runId}:${status}`,
      );
    });
  }
}
