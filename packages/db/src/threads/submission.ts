import { z } from "zod";
import { manualGitRequestSchema } from "../manual-git";
import { modelCredential } from "../schema/model-credentials";
import { modelAcceptsImages, modelSelectionSchema } from "../model-selection";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import * as schema from "../schema";
import {
  agentCheckpoint,
  commandOperation,
  workspace,
  attachment,
  message,
  messageDelivery,
  outbox,
  run,
  thread,
} from "../schema/threads";
import {
  ThreadStoreError,
  type MessageInput,
  type RunRecord,
  type SubmitInput,
  type SubmitResult,
  type ThreadStore,
} from "../thread-contracts";

import {
  activeRunStatuses,
  assertExecutionOwnership,
  lockRunContext,
  unsettledCommandStates,
  appendEvent,
  type Db,
  lifecycleLockKey,
  ownedThread,
  postgresField,
  type Tx,
  uniqueAdmissionError,
} from "./shared";
import { ATTACHMENT_MESSAGE_MAX_BYTES, ATTACHMENT_MESSAGE_MAX_FILES } from "./attachments";

export function createSubmissionStore(
  db: Db,
): Pick<
  ThreadStore,
  | "submitThread"
  | "submitMessage"
  | "readRepository"
  | "pendingSteers"
  | "updatePendingMessage"
  | "startQueuedMessage"
> {
  async function existingClientMessage(
    tx: Tx,
    input: SubmitInput & { mode?: "steer" | "queue" },
    expectedThreadId?: string,
    expectedKind: "initial" | "followup" = expectedThreadId ? "followup" : "initial",
  ): Promise<SubmitResult | null> {
    const rows = await tx
      .select({
        messageId: message.id,
        threadId: message.threadId,
        content: message.content,
        delivery: messageDelivery,
        requestKind: message.requestKind,
        runId: message.runId,
        modelSelection: run.modelSelection,
        repositoryUrl: thread.repositoryUrl,
        repositoryBranch: thread.repositoryBranch,
      })
      .from(message)
      .innerJoin(thread, eq(message.threadId, thread.id))
      .leftJoin(run, eq(message.runId, run.id))
      .leftJoin(messageDelivery, eq(messageDelivery.messageId, message.id))
      .where(
        and(eq(message.userId, input.userId), eq(message.clientMessageId, input.clientMessageId)),
      )
      .limit(1);

    const prior = rows[0];

    if (!prior) return null;

    const [manual] = prior.runId
      ? await tx
          .select()
          .from(agentCheckpoint)
          .where(
            and(
              eq(agentCheckpoint.runId, prior.runId),
              eq(agentCheckpoint.key, "manual-git-request"),
            ),
          )
      : [];

    if (
      JSON.stringify(manual ? manualGitRequestSchema.parse(manual.content) : null) !==
      JSON.stringify(input.manualGit ?? null)
    )
      throw new ThreadStoreError("IDEMPOTENCY_CONFLICT", "Manual action differs", 409);

    const priorAttachments = await tx
      .select({ id: attachment.id })
      .from(attachment)
      .where(eq(attachment.messageId, prior.messageId))
      .orderBy(asc(attachment.ordinal));

    const repositoryUrl =
      expectedKind === "initial" ? (input.repositoryUrl ?? null) : prior.repositoryUrl;

    const repositoryBranch =
      expectedKind === "initial" ? (input.repositoryBranch ?? null) : prior.repositoryBranch;

    if (
      JSON.stringify(
        prior.delivery
          ? modelSelectionSchema.parse(prior.delivery.modelSelection)
          : prior.modelSelection
            ? modelSelectionSchema.parse(prior.modelSelection)
            : null,
      ) !== JSON.stringify(input.modelSelection ?? null) ||
      (prior.delivery?.originalPrompt ?? prior.content) !== input.prompt ||
      prior.delivery?.mode !== input.mode ||
      (expectedThreadId !== undefined && prior.threadId !== expectedThreadId) ||
      prior.requestKind !== expectedKind ||
      prior.repositoryUrl !== repositoryUrl ||
      prior.repositoryBranch !== repositoryBranch ||
      JSON.stringify(
        prior.delivery
          ? z.array(z.uuid()).parse(prior.delivery.originalAttachmentIds)
          : priorAttachments.map((item) => item.id),
      ) !== JSON.stringify(input.attachmentIds ?? [])
    )
      throw new ThreadStoreError(
        "IDEMPOTENCY_CONFLICT",
        "clientMessageId was already used for a different request",
        409,
      );

    const acceptedRunId = prior.delivery?.targetRunId ?? prior.runId;

    if (!acceptedRunId)
      throw new ThreadStoreError("IDEMPOTENCY_STATE", "The original request has no run", 500);

    const result: SubmitResult = { threadId: prior.threadId, runId: acceptedRunId };

    if (prior.delivery) {
      result.messageId = prior.messageId;
      result.delivery = prior.delivery.acceptedAsPending ? "pending" : "run";
    }

    return result;
  }

  async function validateAttachments(tx: Tx, input: SubmitInput, threadId?: string) {
    const ids = input.attachmentIds ?? [];

    if (ids.length > ATTACHMENT_MESSAGE_MAX_FILES || new Set(ids).size !== ids.length)
      throw new ThreadStoreError(
        "INVALID_ATTACHMENTS",
        `A message can contain at most ${ATTACHMENT_MESSAGE_MAX_FILES} distinct attachments`,
        400,
      );

    const rows = ids.length
      ? await tx.select().from(attachment).where(inArray(attachment.id, ids)).for("update")
      : [];

    const byId = new Map(rows.map((item) => [item.id, item]));
    const ordered = ids.map((id) => byId.get(id));

    if (
      ordered.some(
        (item) =>
          !item ||
          item.userId !== input.userId ||
          item.state !== "ready" ||
          item.messageId !== null ||
          item.originalSize === null ||
          item.originalSha256 === null,
      )
    )
      throw new ThreadStoreError(
        "ATTACHMENT_NOT_AVAILABLE",
        "An attachment is missing, unfinished, foreign, or already used",
        409,
      );

    const attachments = ordered.flatMap((item) => (item ? [item] : []));
    const bytes = attachments.reduce((total, item) => total + (item.originalSize ?? 0), 0);

    if (bytes > ATTACHMENT_MESSAGE_MAX_BYTES)
      throw new ThreadStoreError(
        "ATTACHMENT_MESSAGE_TOO_LARGE",
        "Message attachments exceed 50 MiB",
        400,
      );

    let hasImages = attachments.some((item) => item.classification === "image");

    if (!hasImages && threadId) {
      const [priorImage] = await tx
        .select({ id: attachment.id })
        .from(attachment)
        .innerJoin(message, eq(attachment.messageId, message.id))
        .where(and(eq(message.threadId, threadId), eq(attachment.classification, "image")))
        .limit(1);

      hasImages = Boolean(priorImage);
    }

    if (hasImages && input.modelSelection && !modelAcceptsImages(input.modelSelection))
      throw new ThreadStoreError(
        "MODEL_IMAGE_UNSUPPORTED",
        "The selected model does not accept images",
        409,
      );

    return attachments;
  }

  async function onboardingCompleted(tx: Tx, userId: string): Promise<boolean> {
    const [row] = await tx
      .select({ onboardingCompleted: schema.user.onboardingCompleted })
      .from(schema.user)
      .where(eq(schema.user.id, userId))
      .limit(1);

    return row?.onboardingCompleted ?? false;
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
    input: SubmitInput & { mode?: "steer" | "queue" },
    requestedThreadId?: string,
  ): Promise<SubmitResult> {
    if (input.manualGit)
      input = { ...input, manualGit: manualGitRequestSchema.parse(input.manualGit) };

    if (input.modelSelection)
      input = { ...input, modelSelection: modelSelectionSchema.parse(input.modelSelection) };

    return db.transaction(async (tx) => {
      // Lock an existing thread before global admission so its cleanup cannot
      // stall submissions and cancellations for unrelated threads.
      if (requestedThreadId) {
        const owned = await tx
          .select({ id: thread.id })
          .from(thread)
          .where(ownedThread(requestedThreadId, input.userId))
          .for("update")
          .limit(1);

        if (!owned[0]) throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);
      }

      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lifecycleLockKey}))`);
      const expectedKind = requestedThreadId ? "followup" : "initial";
      const prior = await existingClientMessage(tx, input, requestedThreadId, expectedKind);

      if (prior) return prior;

      // New Pi compute requires completed onboarding. This runs after the
      // idempotency lookup so replaying an accepted envelope still returns its
      // original result after credentials change or are removed. Scripted
      // repository-free submissions carry no model selection and stay allowed.
      if (input.modelSelection && !(await onboardingCompleted(tx, input.userId)))
        throw new ThreadStoreError(
          "ONBOARDING_REQUIRED",
          "Finish setup before starting a task.",
          403,
        );

      const attachments = await validateAttachments(tx, input, requestedThreadId);

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

      if (input.mode && !input.modelSelection)
        throw new ThreadStoreError(
          "MODEL_SELECTION_REQUIRED",
          "Choose a model for this message",
          400,
        );

      let activeRun: RunRecord | undefined;

      if (requestedThreadId) {
        const activeThread = await tx
          .select()
          .from(run)
          .where(
            and(eq(run.threadId, requestedThreadId), inArray(run.status, [...activeRunStatuses])),
          )
          .limit(1);

        activeRun = activeThread[0];

        if (activeRun && !input.mode)
          throw new ThreadStoreError(
            "THREAD_BUSY",
            "Choose steer or queue while a run is active",
            409,
          );

        if (
          activeRun &&
          input.mode === "steer" &&
          JSON.stringify(
            activeRun.modelSelection ? modelSelectionSchema.parse(activeRun.modelSelection) : null,
          ) !== JSON.stringify(input.modelSelection)
        )
          throw new ThreadStoreError(
            "MODEL_SELECTION_CONFLICT",
            "Steering uses the active run's model. Queue this message to change models.",
            409,
          );
      }

      if (input.manualGit) {
        if (!requestedThreadId || input.modelSelection)
          throw new ThreadStoreError(
            "INVALID_REQUEST",
            "Manual Git requires an existing thread",
            400,
          );

        const [ws] = await tx
          .select()
          .from(workspace)
          .where(eq(workspace.threadId, requestedThreadId))
          .for("update");

        if (!ws || ws.lifecycleTransitionId)
          throw new ThreadStoreError("THREAD_BUSY", "Workspace is not ready", 409);

        const unsettled = await tx
          .select({ id: commandOperation.commandId })
          .from(commandOperation)
          .where(
            and(
              eq(commandOperation.workspaceId, ws.id),
              inArray(commandOperation.state, [...unsettledCommandStates]),
            ),
          )
          .limit(1);

        if (unsettled.length)
          throw new ThreadStoreError("THREAD_BUSY", "Workspace commands are unsettled", 409);
      }

      if (!activeRun) await ensureGlobalAdmission(tx, input.maxActiveRuns ?? 5);

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

      let createdRun: RunRecord | undefined = activeRun;

      try {
        if (!activeRun) {
          const inserted = await tx
            .insert(run)
            .values({
              threadId: targetThreadId,
              userId: input.userId,
              status: "queued",
              prompt: input.prompt,
              modelSelection: input.modelSelection ?? null,
            })
            .returning();

          createdRun = inserted[0];
        }
      } catch (error) {
        const mapped =
          postgresField(error, "code") === "23505"
            ? uniqueAdmissionError(postgresField(error, "constraint"))
            : null;

        if (mapped) throw mapped;
        throw error;
      }

      if (!createdRun) throw new ThreadStoreError("CREATE_FAILED", "Could not create run", 500);

      if (input.manualGit)
        await tx.insert(agentCheckpoint).values({
          runId: createdRun.id,
          key: "manual-git-request",
          generation: 1,
          content: input.manualGit,
        });

      const createdMessage = await tx
        .insert(message)
        .values({
          threadId: targetThreadId,
          runId: activeRun ? null : createdRun.id,
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

      for (const [ordinal, item] of attachments.entries()) {
        const [bound] = await tx
          .update(attachment)
          .set({ messageId: createdUserMessage.id, ordinal, updatedAt: new Date() })
          .where(
            and(
              eq(attachment.id, item.id),
              eq(attachment.userId, input.userId),
              eq(attachment.state, "ready"),
              sql`${attachment.messageId} is null`,
            ),
          )
          .returning({ id: attachment.id });

        if (!bound)
          throw new ThreadStoreError(
            "ATTACHMENT_NOT_AVAILABLE",
            "An attachment was claimed by another request",
            409,
          );
      }

      if (input.mode && input.modelSelection) {
        const accepted = await appendEvent(
          tx,
          targetThreadId,
          "message.pending",
          {
            messageId: createdUserMessage.id,
            runId: createdRun.id,
            mode: input.mode,
          },
          `message:${createdUserMessage.id}:pending`,
        );

        await tx.insert(messageDelivery).values({
          messageId: createdUserMessage.id,
          targetRunId: createdRun.id,
          mode: input.mode,
          state: activeRun ? "pending" : "started",
          acceptedAsPending: Boolean(activeRun),
          originalPrompt: input.prompt,
          originalAttachmentIds: input.attachmentIds ?? [],
          modelSelection: input.modelSelection,
          sequence: accepted.sequence,
          maxActiveRuns: input.maxActiveRuns ?? 5,
        });
      }

      if (activeRun)
        return {
          threadId: targetThreadId,
          runId: activeRun.id,
          messageId: createdUserMessage.id,
          delivery: "pending",
        };

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

      const result: SubmitResult = { threadId: targetThreadId, runId: createdRun.id };

      if (input.mode) {
        result.messageId = createdUserMessage.id;
        result.delivery = "run";
      }

      return result;
    });
  }

  return {
    submitThread: (input) => submit(input),
    submitMessage: (input: MessageInput) => submit(input, input.threadId),

    async startQueuedMessage({ userId, threadId, messageId }) {
      return db.transaction(async (tx) => {
        const [owned] = await tx
          .select({ id: thread.id })
          .from(thread)
          .where(ownedThread(threadId, userId))
          .for("update");

        if (!owned) throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);

        const [accepted] = await tx
          .select({ message, delivery: messageDelivery })
          .from(messageDelivery)
          .innerJoin(message, eq(messageDelivery.messageId, message.id))
          .where(and(eq(message.id, messageId), eq(message.threadId, threadId)));

        if (accepted?.delivery.state === "started" && accepted.message.runId)
          return { threadId, runId: accepted.message.runId, messageId, delivery: "run" as const };

        const [active] = await tx
          .select({ id: run.id })
          .from(run)
          .where(and(eq(run.threadId, threadId), inArray(run.status, [...activeRunStatuses])));

        if (active)
          throw new ThreadStoreError("THREAD_BUSY", "This thread already has an active run", 409);

        const [next] = await tx
          .select({ id: message.id })
          .from(messageDelivery)
          .innerJoin(message, eq(messageDelivery.messageId, message.id))
          .where(and(eq(message.threadId, threadId), eq(messageDelivery.state, "pending")))
          .orderBy(asc(messageDelivery.sequence))
          .limit(1);

        if (next?.id !== messageId)
          throw new ThreadStoreError("MESSAGE_NOT_PENDING", "Start the first queued message", 409);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lifecycleLockKey}))`);
        const started = await startNextQueuedMessage(tx, threadId, userId);

        if (!started)
          throw new ThreadStoreError(
            "ACTIVE_RUN_LIMIT",
            "The active run limit has been reached",
            429,
          );

        return started;
      });
    },

    async pendingSteers({ runId, ownershipToken }) {
      return db.transaction(async (tx) => {
        const { current, workspace } = await lockRunContext(tx, runId, true);
        assertExecutionOwnership(
          current,
          ownershipToken,
          current.executionOwnerAttemptId ?? "",
          workspace?.generation ?? 1,
        );

        if (
          current.cancelRequestedAt ||
          current.status !== "running" ||
          current.approvalWaitStartedAt ||
          current.questionWaitStartedAt
        )
          return [];

        return tx
          .select({ id: message.id, content: message.content })
          .from(messageDelivery)
          .innerJoin(message, eq(messageDelivery.messageId, message.id))
          .where(
            and(
              eq(messageDelivery.targetRunId, runId),
              eq(messageDelivery.mode, "steer"),
              eq(messageDelivery.state, "pending"),
            ),
          )
          .orderBy(asc(messageDelivery.sequence));
      });
    },

    async updatePendingMessage({ userId, threadId, messageId, prompt }) {
      await db.transaction(async (tx) => {
        const [owned] = await tx
          .select()
          .from(thread)
          .where(ownedThread(threadId, userId))
          .for("update");

        if (!owned) throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);

        const [pending] = await tx
          .select({ message, delivery: messageDelivery })
          .from(messageDelivery)
          .innerJoin(message, eq(messageDelivery.messageId, message.id))
          .where(
            and(
              eq(message.id, messageId),
              eq(message.threadId, threadId),
              eq(messageDelivery.state, "pending"),
            ),
          );

        if (!pending)
          throw new ThreadStoreError(
            "MESSAGE_NOT_PENDING",
            "Message was already delivered or removed",
            409,
          );

        // A steer may already be in Pi's queue. It stays immutable until consumed.
        if (pending.delivery.mode === "steer") {
          const [target] = await tx
            .select({ status: run.status })
            .from(run)
            .where(eq(run.id, pending.delivery.targetRunId));

          if (target && activeRunStatuses.some((status) => status === target.status))
            throw new ThreadStoreError(
              "MESSAGE_NOT_EDITABLE",
              "An active steer cannot be edited",
              409,
            );
        }

        if (prompt === null) {
          await tx
            .update(messageDelivery)
            .set({ state: "removed" })
            .where(eq(messageDelivery.messageId, messageId));
          await tx
            .update(attachment)
            .set({ messageId: null, ordinal: null, updatedAt: new Date() })
            .where(eq(attachment.messageId, messageId));
        } else {
          const text = prompt.trim();

          if (!text || text.length > 100_000)
            throw new ThreadStoreError(
              "INVALID_PAYLOAD",
              "Message must contain 1–100,000 characters",
              400,
            );
          await tx.update(message).set({ content: text }).where(eq(message.id, messageId));
        }

        await appendEvent(
          tx,
          threadId,
          "message.pending.updated",
          { messageId },
          `message:${messageId}:update:${crypto.randomUUID()}`,
        );
      });
    },

    async readRepository({ userId, threadId }) {
      const rows = await db
        .select({
          repositoryUrl: thread.repositoryUrl,
          repositoryBranch: thread.repositoryBranch,
          branchSuggestion: thread.branchSuggestion,
        })
        .from(thread)
        .where(ownedThread(threadId, userId))
        .limit(1);

      if (!rows[0]) throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);

      return rows[0];
    },
  };
}

/** Thread and global admission locks must be held by the caller. */
export async function startNextQueuedMessage(tx: Tx, threadId: string, userId: string) {
  const [next] = await tx
    .select({ message, delivery: messageDelivery })
    .from(messageDelivery)
    .innerJoin(message, eq(messageDelivery.messageId, message.id))
    .where(and(eq(message.threadId, threadId), eq(messageDelivery.state, "pending")))
    .orderBy(asc(messageDelivery.sequence))
    .limit(1);

  if (!next) return;

  const [count] = await tx
    .select({ active: sql<number>`count(*)` })
    .from(run)
    .where(inArray(run.status, [...activeRunStatuses]));

  if (Number(count?.active ?? 0) >= next.delivery.maxActiveRuns) return;

  const [created] = await tx
    .insert(run)
    .values({
      threadId,
      userId,
      status: "queued",
      prompt: next.message.content,
      modelSelection: modelSelectionSchema.parse(next.delivery.modelSelection),
    })
    .returning();

  if (!created) throw new ThreadStoreError("CREATE_FAILED", "Could not start queued message", 500);
  await tx.update(message).set({ runId: created.id }).where(eq(message.id, next.message.id));
  await tx
    .update(messageDelivery)
    .set({ state: "started" })
    .where(eq(messageDelivery.messageId, next.message.id));
  await appendEvent(
    tx,
    threadId,
    "run.queued",
    { runId: created.id, messageId: next.message.id },
    `run:${created.id}:queued`,
  );
  await tx.insert(outbox).values({ type: "run.requested", threadId, runId: created.id });

  return { threadId, runId: created.id, messageId: next.message.id, delivery: "run" as const };
}
