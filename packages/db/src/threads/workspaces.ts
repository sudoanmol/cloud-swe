import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { commandOperation, threadEvent, workspace } from "../schema/threads";
import {
  ThreadStoreError,
  WORKSPACE_RESET_INSTRUCTION,
  type CleanupProviderResult,
  type CleanupResult,
  type ThreadStore,
} from "../thread-contracts";

import {
  appendEvent,
  cleanupBlockReason,
  type Db,
  lockThreadAndWorkspace,
  lockWorkspaceContext,
  payloadNumber,
  unsettledCommandStates,
} from "./shared";

export function createWorkspacesStore(
  db: Db,
): Pick<
  ThreadStore,
  | "updateWorkspace"
  | "readWorkspace"
  | "persistRecoveredProviderId"
  | "resetWorkspace"
  | "beginLifecycleTransition"
  | "cancelLifecycleTransition"
  | "cleanupWorkspace"
> {
  return {
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

        const updates: Partial<typeof workspace.$inferInsert> = {
          state,
          lifecycleTransitionId: null,
          lifecycleTransitionState: null,
          updatedAt: now,
        };

        if (provider !== undefined) updates.provider = provider;

        if (providerId !== undefined) updates.providerId = providerId;

        if (name !== undefined) updates.name = name;

        if (generation !== undefined) updates.generation = generation;

        const updated = await tx
          .update(workspace)
          .set(updates)
          .where(eq(workspace.id, current.id))
          .returning();

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
        await lockWorkspaceContext(tx, workspaceId);

        const updated = await tx
          .update(workspace)
          .set({ providerId, updatedAt: new Date() })
          .where(eq(workspace.id, workspaceId))
          .returning();

        if (!updated[0])
          throw new ThreadStoreError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);

        return updated[0];
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
              state: "failed",
              completedAt: now,
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
                inArray(commandOperation.state, [...unsettledCommandStates]),
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

        const updated = await tx
          .update(workspace)
          .set({
            state: nextState,
            providerId: nextProviderId,
            lifecycleTransitionId: null,
            lifecycleTransitionState: null,
            updatedAt: new Date(),
          })
          .where(eq(workspace.id, current.id))
          .returning();

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

        if (!updated[0])
          throw new ThreadStoreError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);

        return { outcome: missing ? "missing" : "completed", transitionId, workspace: updated[0] };
      });
    },
  };
}
