import { and, asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { message, thread } from "../schema/threads";
import { ThreadStoreError, type ThreadStore } from "../thread-contracts";
import { appendEvent, ownedThread, type Db } from "./shared";

/**
 * At-most-once title generation claims.
 *
 * A claim commits before any request is dispatched. Concurrent claims serialize
 * on the thread row, so exactly one caller wins and a process crash leaves the
 * thread permanently titled `New Thread` rather than retrying.
 */
export function createTitlesStore(
  db: Db,
): Pick<ThreadStore, "claimTitleGeneration" | "completeTitleGeneration" | "renameThread"> {
  return {
    async claimTitleGeneration({ threadId, userId }) {
      return db.transaction(async (tx) => {
        const [current] = await tx
          .select({
            id: thread.id,
            title: thread.title,
            titleGenerationStartedAt: thread.titleGenerationStartedAt,
          })
          .from(thread)
          .where(ownedThread(threadId, userId))
          .for("update")
          .limit(1);

        if (!current) return { claimed: false, prompt: null };

        if (current.titleGenerationStartedAt || current.title)
          return { claimed: false, prompt: null };

        await tx
          .update(thread)
          .set({ titleGenerationStartedAt: new Date() })
          .where(eq(thread.id, threadId));

        // Title only from the persisted first user prompt, never a follow-up.
        const [firstMessage] = await tx
          .select({ content: message.content })
          .from(message)
          .where(and(eq(message.threadId, threadId), eq(message.role, "user")))
          .orderBy(asc(message.createdAt), asc(message.id))
          .limit(1);

        return { claimed: true, prompt: firstMessage?.content ?? null };
      });
    },

    async completeTitleGeneration({ threadId, userId, title, branch }) {
      await db.transaction(async (tx) => {
        const [current] = await tx
          .select({ id: thread.id, title: thread.title })
          .from(thread)
          .where(ownedThread(threadId, userId))
          .for("update")
          .limit(1);

        if (!current) return;

        if (branch)
          await tx.update(thread).set({ branchSuggestion: branch }).where(eq(thread.id, threadId));

        if (current.title) return;

        await tx.update(thread).set({ title }).where(eq(thread.id, threadId));

        // A thread event, not a run event: the run may already be terminal.
        await appendEvent(
          tx,
          threadId,
          "thread.title.updated",
          { title },
          `thread:${threadId}:title:updated`,
        );
      });
    },

    async renameThread({ threadId, userId, title }) {
      await db.transaction(async (tx) => {
        const [current] = await tx
          .select({ id: thread.id })
          .from(thread)
          .where(ownedThread(threadId, userId))
          .for("update")
          .limit(1);

        if (!current) throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);

        await tx.update(thread).set({ title }).where(eq(thread.id, threadId));
        await appendEvent(tx, threadId, "thread.title.updated", { title }, `title:${randomUUID()}`);
      });
    },
  };
}
