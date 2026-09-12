import { and, eq, inArray } from "drizzle-orm";
import {
  publicFailureCodeForMessage,
  publicFailureMessage,
  publicFailureForCode,
} from "../public-failure";
import {
  commandOperation,
  message,
  outbox,
  run,
  runExecutionOwner,
  thread,
} from "../schema/threads";
import { ThreadStoreError, type RunRecord, type ThreadStore } from "../thread-contracts";

import {
  appendEvent,
  assertExecutionOwnership,
  type Db,
  isActiveRun,
  isTerminalRun,
  lockRunContext,
  settleTurn,
} from "./shared";

export function createRunsStore(
  db: Db,
): Pick<
  ThreadStore,
  | "beginAgentExecution"
  | "requestCancel"
  | "loadRun"
  | "startRun"
  | "claimExecutionOwnership"
  | "appendRunEvent"
  | "completeRun"
  | "failRun"
  | "cancelRun"
> {
  async function finish(
    runId: string,
    status: "failed" | "cancelled",
    error?: string,
    failureCode?: string,
  ) {
    await db.transaction(async (tx) => {
      const { current } = await lockRunContext(tx, runId, false);

      if (isTerminalRun(current.status)) return;
      await tx
        .update(commandOperation)
        .set({
          state: "failed",
          cancellationRequested: true,
          completedAt: new Date(),
          result: { kind: "cancelled-before-dispatch" },
        })
        .where(and(eq(commandOperation.runId, runId), eq(commandOperation.state, "queued")));

      const code = publicFailureForCode(
        failureCode ?? publicFailureCodeForMessage(error ?? ""),
      ).code;

      const deadline = code === "DEMO_EXECUTION_DEADLINE" || code === "RUN_TIMEOUT";

      const turnRestored = await settleTurn(
        tx,
        current,
        deadline || (status === "cancelled" && current.agentStartedAt !== null),
      );

      const publicError = error
        ? publicFailureMessage(error) + (turnRestored ? " Your demo turn was restored." : "")
        : null;

      await tx
        .update(run)
        .set({ status, error: publicError, completedAt: new Date(), updatedAt: new Date() })
        .where(eq(run.id, runId));
      await appendEvent(
        tx,
        current.threadId,
        `run.${status}`,
        { runId, error: publicError || undefined, code, turnRestored },
        `run:${runId}:${status}`,
      );
    });
  }

  return {
    async beginAgentExecution(runId, ownershipToken) {
      return db.transaction(async (tx) => {
        const { current, workspace: currentWorkspace } = await lockRunContext(tx, runId, true);
        assertExecutionOwnership(
          current,
          ownershipToken,
          current.executionOwnerAttemptId ?? "",
          currentWorkspace?.generation ?? 1,
        );

        if (isTerminalRun(current.status))
          throw new ThreadStoreError("RUN_TERMINAL", "Run is no longer active");

        if (current.cancelRequestedAt)
          throw new ThreadStoreError("RUN_TERMINAL", "Run was cancelled before execution");

        if (current.agentStartedAt) return current.agentStartedAt;
        const startedAt = new Date();
        await tx.update(run).set({ agentStartedAt: startedAt }).where(eq(run.id, runId));

        return startedAt;
      });
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

    async claimExecutionOwnership({ runId, attemptId, generation }) {
      if (!attemptId)
        throw new ThreadStoreError("ATTEMPT_REQUIRED", "Execution attempt is required", 400);

      return db.transaction(async (tx) => {
        const { current, workspace: lockedWorkspace } = await lockRunContext(tx, runId, true);

        if (!isActiveRun(current.status))
          throw new ThreadStoreError("RUN_TERMINAL", "Cannot claim a terminal run", 409);
        const currentGeneration = lockedWorkspace?.generation ?? 1;

        if (generation !== currentGeneration)
          throw new ThreadStoreError(
            "WORKSPACE_GENERATION_MISMATCH",
            "Execution generation does not match the workspace",
            409,
          );

        const prior = await tx
          .select()
          .from(runExecutionOwner)
          .where(
            and(eq(runExecutionOwner.runId, runId), eq(runExecutionOwner.attemptId, attemptId)),
          )
          .limit(1);

        if (prior[0]) {
          if (
            current.executionOwnerToken !== prior[0].token ||
            prior[0].generation !== currentGeneration ||
            current.executionOwnerGeneration !== currentGeneration
          )
            throw new ThreadStoreError(
              "CHECKPOINT_OWNERSHIP_LOST",
              "This execution attempt no longer owns the run",
              409,
            );

          return { attemptId, token: prior[0].token, generation: currentGeneration };
        }

        const dispatched = await tx
          .select({ id: commandOperation.commandId })
          .from(commandOperation)
          .where(
            and(
              eq(commandOperation.runId, runId),
              eq(commandOperation.generation, currentGeneration),
              inArray(commandOperation.state, ["pending", "running", "unknown"]),
            ),
          )
          .limit(1);

        if (dispatched.length)
          throw new ThreadStoreError(
            "COMMAND_UNSETTLED",
            "Reconcile dispatched commands before replacing execution ownership",
            409,
          );

        await tx
          .update(commandOperation)
          .set({
            state: "failed",
            cancellationRequested: true,
            completedAt: new Date(),
            result: { kind: "superseded-before-dispatch" },
          })
          .where(and(eq(commandOperation.runId, runId), eq(commandOperation.state, "queued")));

        const inserted = await tx
          .insert(runExecutionOwner)
          .values({ runId, attemptId, generation: currentGeneration })
          .returning({ token: runExecutionOwner.token });

        const token = inserted[0]?.token;

        if (!token)
          throw new ThreadStoreError(
            "OWNERSHIP_CLAIM_FAILED",
            "Could not claim execution ownership",
            500,
          );

        await tx
          .update(run)
          .set({
            executionOwnerAttemptId: attemptId,
            executionOwnerToken: token,
            executionOwnerGeneration: currentGeneration,
            updatedAt: new Date(),
          })
          .where(eq(run.id, runId));

        return { attemptId, token, generation: currentGeneration };
      });
    },

    async appendRunEvent({ runId, ownershipToken, type, payload, dedupeKey }) {
      return db.transaction(async (tx) => {
        const { current, workspace: lockedWorkspace } = await lockRunContext(tx, runId, true);

        if (isTerminalRun(current.status))
          throw new ThreadStoreError("RUN_TERMINAL", "Cannot append to a terminal run", 409);
        assertExecutionOwnership(
          current,
          ownershipToken,
          current.executionOwnerAttemptId ?? "",
          lockedWorkspace?.generation ?? 1,
        );

        return appendEvent(tx, current.threadId, type, payload, dedupeKey);
      });
    },

    async completeRun(runId, assistantContent, ownershipToken) {
      await db.transaction(async (tx) => {
        const { current, workspace: lockedWorkspace } = await lockRunContext(tx, runId, true);

        assertExecutionOwnership(
          current,
          ownershipToken,
          current.executionOwnerAttemptId ?? "",
          lockedWorkspace?.generation ?? 1,
        );

        if (isTerminalRun(current.status)) return;

        if (current.cancelRequestedAt) {
          await settleTurn(tx, current, current.agentStartedAt !== null);
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

        await settleTurn(tx, current, true);

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

    async failRun(runId, error, failureCode) {
      await finish(runId, "failed", error, failureCode);
    },

    async cancelRun(runId) {
      await finish(runId, "cancelled");
    },
  };
}
