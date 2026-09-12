import { publishGitProposal } from "../git-store";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import {
  decodePiSessionCheckpoint,
  decodeStoredPiSessionCheckpoint,
  InvalidPiCheckpointError,
  storedPiSessionSchema,
} from "../checkpoint";
import { agentCheckpoint, agentCheckpointEntry, run } from "../schema/threads";
import { ThreadStoreError, type CheckpointRecord, type ThreadStore } from "../thread-contracts";

import {
  assertExecutionOwnership,
  type Db,
  isTerminalRun,
  lockRunContext,
  type Tx,
} from "./shared";

export function createCheckpointsStore(
  db: Db,
): Pick<ThreadStore, "saveCheckpoint" | "loadCheckpoint" | "loadLatestCheckpoint"> {
  async function restoreCheckpoint(
    tx: Tx,
    checkpoint: CheckpointRecord | undefined,
  ): Promise<CheckpointRecord | null> {
    if (!checkpoint) return null;

    if (checkpoint.key !== "pi-session") return checkpoint;

    const stored = storedPiSessionSchema.safeParse(checkpoint.content);

    if (!stored.success) {
      try {
        return { ...checkpoint, content: decodePiSessionCheckpoint(checkpoint.content) };
      } catch (error) {
        if (error instanceof InvalidPiCheckpointError)
          throw new ThreadStoreError("INVALID_CHECKPOINT", error.message, 422);
        throw error;
      }
    }

    const entries = await tx
      .select()
      .from(agentCheckpointEntry)
      .where(eq(agentCheckpointEntry.checkpointId, checkpoint.id))
      .orderBy(asc(agentCheckpointEntry.ordinal));

    if (entries.some((entry, index) => entry.ordinal !== index))
      throw new ThreadStoreError("INVALID_CHECKPOINT", "Saved session entries are incomplete", 422);

    let content: ReturnType<typeof decodePiSessionCheckpoint>;

    try {
      content = decodeStoredPiSessionCheckpoint(
        stored.data.metadata,
        entries.map((entry) => entry.content),
        stored.data.entryCount,
      );
    } catch (error) {
      if (error instanceof InvalidPiCheckpointError)
        throw new ThreadStoreError("INVALID_CHECKPOINT", error.message, 422);
      throw error;
    }

    return {
      ...checkpoint,
      content,
    };
  }

  return {
    async saveCheckpoint({
      runId,
      key,
      content,
      generation,
      attemptId,
      ownershipToken,
      gitProposal,
    }) {
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

        assertExecutionOwnership(current, ownershipToken, attemptId, effectiveGeneration);

        if (gitProposal) {
          if (key !== "pi-session")
            throw new ThreadStoreError(
              "INVALID_CHECKPOINT",
              "Approval requires a Pi checkpoint",
              422,
            );
          await publishGitProposal(tx, current, effectiveGeneration, gitProposal);
        }

        let entries: unknown[] | null = null;
        let storedContent = content;

        if (key === "pi-session") {
          try {
            const decoded = decodePiSessionCheckpoint(content);
            entries = decoded.entries;
            const { entries: _entries, ...metadata } = decoded;
            storedContent = {
              storage: "pi-session-entries-v1",
              metadata,
              entryCount: _entries.length,
            };
          } catch (error) {
            if (error instanceof InvalidPiCheckpointError)
              throw new ThreadStoreError("INVALID_CHECKPOINT", error.message, 422);
            throw error;
          }
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
  };
}
