import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { gitOperation } from "../schema/git";
import { attachment, message, outbox, run, thread } from "../schema/threads";
import { ThreadStoreError, type ThreadStore } from "../thread-contracts";
import { activeRunStatuses, ownedThread, type Db, type Tx } from "./shared";

/**
 * Deletion is a tombstone then a purge. The tombstone hides the thread from
 * every owner read at once; the thread workflow deletes the workspace and then
 * purges the rows, so no provider resource outlives the row that names it.
 */
export function createDeletionStore(db: Db): Pick<ThreadStore, "deleteThread" | "purgeThread"> {
  return {
    async deleteThread({ userId, threadId }) {
      await db.transaction(async (tx) => {
        const [owned] = await tx
          .select({ id: thread.id })
          .from(thread)
          .where(ownedThread(threadId, userId))
          .for("update")
          .limit(1);

        if (!owned) throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);
        await assertSettled(tx, threadId);

        await tx.update(thread).set({ deletedAt: new Date() }).where(eq(thread.id, threadId));
        await tx.insert(outbox).values({ type: "thread.delete", threadId });
      });
    },

    async purgeThread(threadId) {
      await db.transaction(async (tx) => {
        const [deleted] = await tx
          .select({ id: thread.id })
          .from(thread)
          .where(and(eq(thread.id, threadId), isNotNull(thread.deletedAt)))
          .for("update")
          .limit(1);

        if (!deleted) return;
        await assertSettled(tx, threadId);

        // Detached uploads reach the hourly attachment cleanup, which deletes their objects.
        await tx
          .update(attachment)
          .set({ messageId: null, ordinal: null, state: "deleting", updatedAt: new Date() })
          .where(
            inArray(
              attachment.messageId,
              tx.select({ id: message.id }).from(message).where(eq(message.threadId, threadId)),
            ),
          );
        await tx.delete(thread).where(eq(thread.id, threadId));
      });
    },
  };
}

/** Active runs and unsettled Git writes keep the thread until they resolve. */
async function assertSettled(tx: Tx, threadId: string) {
  const [active] = await tx
    .select({ id: run.id })
    .from(run)
    .where(and(eq(run.threadId, threadId), inArray(run.status, [...activeRunStatuses])))
    .limit(1);

  if (active)
    throw new ThreadStoreError("THREAD_BUSY", "This thread already has an active run", 409);

  const [unsettled] = await tx
    .select({ id: gitOperation.id })
    .from(gitOperation)
    .where(
      and(
        eq(gitOperation.threadId, threadId),
        inArray(gitOperation.execution, ["executing", "unknown"]),
      ),
    )
    .limit(1);

  if (unsettled)
    throw new ThreadStoreError("THREAD_BUSY", "A Git write on this thread is still settling", 409);
}
