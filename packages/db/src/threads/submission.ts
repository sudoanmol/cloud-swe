import { modelCredential } from "../schema/model-credentials";
import { modelSelectionSchema } from "../model-selection";
import { and, eq, inArray, sql } from "drizzle-orm";
import * as schema from "../schema";
import { demoTurn, message, outbox, run, thread } from "../schema/threads";
import {
  ThreadStoreError,
  type MessageInput,
  type RunRecord,
  type SubmitInput,
  type ThreadStore,
} from "../thread-contracts";

import {
  activeRunStatuses,
  appendEvent,
  type Db,
  lifecycleLockKey,
  postgresField,
  type Tx,
  uniqueAdmissionError,
} from "./shared";

export function createSubmissionStore(
  db: Db,
  options: { primaryGithubAccountId?: string },
): Pick<
  ThreadStore,
  "submitThread" | "submitMessage" | "readRepository" | "isOwner" | "threadIsOwner"
> {
  async function isOwner(userId: string, connection: Db | Tx = db): Promise<boolean> {
    const id = options.primaryGithubAccountId;

    if (!id || !/^[1-9][0-9]*$/.test(id)) return false;

    const rows = await connection
      .select({ id: schema.account.id })
      .from(schema.account)
      .where(
        and(
          eq(schema.account.userId, userId),
          eq(schema.account.providerId, "github"),
          eq(schema.account.accountId, id),
        ),
      )
      .limit(1);

    return rows.length > 0;
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
        modelSelection: run.modelSelection,
        repositoryUrl: thread.repositoryUrl,
        repositoryBranch: thread.repositoryBranch,
      })
      .from(message)
      .innerJoin(thread, eq(message.threadId, thread.id))
      .leftJoin(run, eq(message.runId, run.id))
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
      JSON.stringify(
        prior.modelSelection ? modelSelectionSchema.parse(prior.modelSelection) : null,
      ) !== JSON.stringify(input.modelSelection ?? null) ||
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

    return { threadId: prior.threadId, runId: prior.runId };
  }

  async function ensureGlobalAdmission(tx: Tx, maxActiveRuns = 5): Promise<void> {
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
    if (input.modelSelection)
      input = { ...input, modelSelection: modelSelectionSchema.parse(input.modelSelection) };

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

      if (input.modelSelection) {
        const [credential] = await tx
          .select({ provider: modelCredential.provider })
          .from(modelCredential)
          .where(
            and(
              eq(modelCredential.userId, input.userId),
              eq(modelCredential.provider, input.modelSelection.provider),
            ),
          );

        if (!credential)
          throw new ThreadStoreError(
            "MODEL_CREDENTIAL_REQUIRED",
            "Connect your model provider before starting a task.",
            409,
          );
      }

      if (requestedThreadId) {
        const activeThread = await tx
          .select({ id: run.id })
          .from(run)
          .where(
            and(eq(run.threadId, requestedThreadId), inArray(run.status, [...activeRunStatuses])),
          )
          .limit(1);

        if (activeThread[0])
          throw new ThreadStoreError("THREAD_BUSY", "This thread already has an active run", 409);
      }

      await ensureGlobalAdmission(tx, input.maxActiveRuns ?? 5);
      const owner = await isOwner(input.userId, tx);

      const active = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(run)
        .where(and(eq(run.userId, input.userId), inArray(run.status, [...activeRunStatuses])));

      if ((active[0]?.count ?? 0) >= (owner ? 5 : 1))
        throw new ThreadStoreError(
          "USER_BUSY",
          "The user's concurrent task allowance is in use",
          409,
        );

      if (!owner) {
        const turns = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(demoTurn)
          .where(
            and(
              eq(demoTurn.userId, input.userId),
              inArray(demoTurn.state, ["reserved", "consumed"]),
            ),
          );

        if ((turns[0]?.count ?? 0) >= 3)
          throw new ThreadStoreError(
            "DEMO_TURN_LIMIT",
            "You've used your three live-demo turns.",
            429,
          );
      }

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
            modelSelection: input.modelSelection ?? null,
            accessPolicy: owner ? "owner" : "demo",
          })
          .returning();

        createdRun = inserted[0];
      } catch (error) {
        const mapped =
          postgresField(error, "code") === "23505"
            ? uniqueAdmissionError(postgresField(error, "constraint"))
            : null;

        if (mapped) throw mapped;
        throw error;
      }

      if (!createdRun) throw new ThreadStoreError("CREATE_FAILED", "Could not create run", 500);

      if (!owner)
        await tx
          .insert(demoTurn)
          .values({ runId: createdRun.id, userId: input.userId, state: "reserved" });

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
      });

      return { threadId: targetThreadId, runId: createdRun.id };
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

    isOwner,
    async threadIsOwner(threadId) {
      const rows = await db
        .select({ userId: thread.userId })
        .from(thread)
        .where(eq(thread.id, threadId))
        .limit(1);

      return rows[0] ? isOwner(rows[0].userId) : false;
    },
  };
}
