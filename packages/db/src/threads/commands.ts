import { and, asc, eq, inArray } from "drizzle-orm";
import { commandOperation, run } from "../schema/threads";
import {
  ThreadStoreError,
  type CommandBeginInput,
  type CommandUpdateInput,
  type ThreadStore,
} from "../thread-contracts";

import {
  assertExecutionOwnership,
  type Db,
  isActiveRun,
  isTerminalRun,
  lockWorkspaceContext,
  type Tx,
  unsettledCommandStates,
} from "./shared";

type CommandRow = typeof commandOperation.$inferSelect;

function assertWorkspaceAcceptsCommand(
  workspace: Awaited<ReturnType<typeof lockWorkspaceContext>>["workspace"],
  input: CommandBeginInput,
): void {
  if (workspace.generation !== input.generation)
    throw new ThreadStoreError(
      "WORKSPACE_GENERATION_MISMATCH",
      "Command generation does not match the workspace",
      409,
    );

  if (["paused", "quarantined", "recovery", "deleted", "failed"].includes(workspace.state))
    throw new ThreadStoreError(
      "WORKSPACE_UNAVAILABLE",
      "Commands cannot start while the workspace requires recovery",
      409,
    );

  if (workspace.lifecycleTransitionId)
    throw new ThreadStoreError(
      "LIFECYCLE_TRANSITION_PENDING",
      "Commands cannot start while a workspace lifecycle transition is pending",
      409,
    );

  if (input.attemptId.length === 0)
    throw new ThreadStoreError("COMMAND_ATTEMPT_REQUIRED", "Command attemptId is required", 400);
}

/** An idempotent retry returns the operation it already created, if the same owner asks. */
async function findExistingCommand(
  tx: Tx,
  input: CommandBeginInput,
  currentRun: typeof run.$inferSelect,
): Promise<CommandRow | null> {
  if (!input.commandId) return null;

  const existingRows = await tx
    .select()
    .from(commandOperation)
    .where(eq(commandOperation.commandId, input.commandId))
    .for("update")
    .limit(1);

  const existing = existingRows[0];

  if (!existing) return null;

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
    throw new ThreadStoreError("RUN_TERMINAL", "Cannot resume a command for a non-active run", 409);
  }

  return existing;
}

async function assertQueueAdmits(tx: Tx, input: CommandBeginInput): Promise<void> {
  const outstanding = await tx
    .select()
    .from(commandOperation)
    .where(
      and(
        eq(commandOperation.workspaceId, input.workspaceId),
        eq(commandOperation.generation, input.generation),
        inArray(commandOperation.state, [...unsettledCommandStates]),
      ),
    );

  if (outstanding.length >= 36)
    throw new ThreadStoreError("COMMAND_QUEUE_FULL", "Workspace command queue is full", 429);

  if (!input.queued && outstanding.length)
    throw new ThreadStoreError("COMMAND_UNSETTLED", "Workspace has outstanding commands", 409);

  if (!input.queued && input.access === "read")
    throw new ThreadStoreError(
      "COMMAND_QUEUE_REQUIRED",
      "Shared reads require queued admission",
      400,
    );
}

export function createCommandsStore(
  db: Db,
): Pick<
  ThreadStore,
  "beginCommand" | "admitCommand" | "readCommand" | "listUnsettledCommands" | "updateCommand"
> {
  return {
    async beginCommand(input: CommandBeginInput) {
      return db.transaction(async (tx) => {
        const context = await lockWorkspaceContext(tx, input.workspaceId);

        assertWorkspaceAcceptsCommand(context.workspace, input);

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

        assertExecutionOwnership(
          currentRun,
          input.ownershipToken,
          input.attemptId,
          input.generation,
        );

        if (currentRun.cancelRequestedAt)
          throw new ThreadStoreError("RUN_CANCELLED", "Run cancellation was requested", 409);

        const existing = await findExistingCommand(tx, input, currentRun);

        if (existing) return existing;

        if (!isActiveRun(currentRun.status))
          throw new ThreadStoreError(
            isTerminalRun(currentRun.status) ? "RUN_TERMINAL" : "RUN_NOT_ACTIVE",
            "Commands require an active run",
            409,
          );

        await assertQueueAdmits(tx, input);

        const inserted = await tx
          .insert(commandOperation)
          .values({
            commandId: input.commandId,
            workspaceId: input.workspaceId,
            generation: input.generation,
            runId: input.runId,
            attemptId: input.attemptId,
            metadata: input.metadata,
            access: input.access ?? "exclusive",
            ownershipToken: input.ownershipToken,
            state: input.queued ? "queued" : "pending",
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
      });
    },

    async admitCommand(commandId) {
      const record = await this.readCommand(commandId);

      if (!record) throw new ThreadStoreError("COMMAND_NOT_FOUND", "Command not found", 404);

      return db.transaction(async (tx) => {
        const context = await lockWorkspaceContext(tx, record.workspaceId);
        const rows = await tx.select().from(run).where(eq(run.id, record.runId)).for("update");
        const current = rows[0];

        if (!current || !isActiveRun(current.status) || current.cancelRequestedAt)
          throw new ThreadStoreError("RUN_CANCELLED", "Run is no longer executable", 409);
        assertExecutionOwnership(
          current,
          record.ownershipToken ?? "",
          record.attemptId,
          context.workspace.generation,
        );

        if (
          context.workspace.generation !== record.generation ||
          context.workspace.lifecycleTransitionId ||
          !["running", "provisioning"].includes(context.workspace.state)
        )
          throw new ThreadStoreError(
            "WORKSPACE_UNAVAILABLE",
            "Workspace is unavailable for dispatch",
            409,
          );

        const outstanding = await tx
          .select()
          .from(commandOperation)
          .where(
            and(
              eq(commandOperation.workspaceId, record.workspaceId),
              eq(commandOperation.generation, record.generation),
              inArray(commandOperation.state, [...unsettledCommandStates]),
            ),
          )
          .orderBy(asc(commandOperation.queueOrder));

        const pending = outstanding.find((item) => item.commandId === commandId);

        if (!pending || pending.state !== "queued")
          throw new ThreadStoreError("COMMAND_NOT_QUEUED", "Command is no longer queued", 409);
        const active = outstanding.filter((item) => item.state !== "queued");

        // A previous attempt's reads must be reconciled before this owner dispatches anything.
        if (
          active.some(
            (item) => item.state === "unknown" || item.ownershipToken !== record.ownershipToken,
          )
        )
          return null;

        const earlier = outstanding.filter(
          (item) => item.state === "queued" && item.queueOrder < pending.queueOrder,
        );

        if (
          pending.access === "exclusive"
            ? active.length || earlier.length
            : active.some((item) => item.access === "exclusive") ||
              earlier.some((item) => item.access === "exclusive")
        )
          return null;

        const slot =
          pending.access === "read"
            ? [1, 2, 3, 4].find((candidate) => !active.some((item) => item.readSlot === candidate))
            : null;

        if (slot === undefined) return null;

        const updated = await tx
          .update(commandOperation)
          .set({ state: "pending", readSlot: slot })
          .where(eq(commandOperation.commandId, commandId))
          .returning();

        return updated[0] ?? null;
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

        const updates: Partial<typeof commandOperation.$inferInsert> = { updatedAt: now };

        if (state) updates.state = state;

        if (cancellationRequested !== undefined)
          updates.cancellationRequested = cancellationRequested;

        if (metadata !== undefined) updates.metadata = metadata;

        if (result !== undefined) updates.result = result;

        if (state === "running" && !current.startedAt) updates.startedAt = now;

        if (state && isTerminalCommand(state)) updates.completedAt = current.completedAt ?? now;

        const updated = await tx
          .update(commandOperation)
          .set(updates)
          .where(eq(commandOperation.commandId, commandId))
          .returning();

        if (!updated[0])
          throw new ThreadStoreError("COMMAND_NOT_FOUND", "Command operation not found", 404);

        return updated[0];
      });
    },
  };
}

function isTerminalCommand(state: string): boolean {
  return state === "completed" || state === "failed";
}
