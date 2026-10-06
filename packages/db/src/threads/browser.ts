import { and, eq, ne } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { BrowserOwner } from "../pi-events";
import { answerQuestionInTransaction } from "../question-store";
import { questionRequest } from "../schema/questions";
import { questionRequestSchema } from "../question-contracts";
import { thread } from "../schema/threads";
import { ThreadStoreError, type ThreadStore } from "../thread-contracts";
import { appendEvent, type Db, ownedThread, type Tx } from "./shared";

/** Hands the thread's browser to `owner`; a change appends `browser.owner_changed`. */
export async function setBrowserOwner(tx: Tx, threadId: string, owner: BrowserOwner) {
  const changed = await tx
    .update(thread)
    .set({ browserOwner: owner })
    .where(and(eq(thread.id, threadId), ne(thread.browserOwner, owner)))
    .returning({ id: thread.id });

  if (changed[0])
    await appendEvent(
      tx,
      threadId,
      "browser.owner_changed",
      { owner },
      `browser:owner:${randomUUID()}`,
    );
}

export function createBrowserStore(
  db: Db,
): Pick<ThreadStore, "readBrowserOwner" | "changeBrowserOwner" | "recordBrowserActivity"> {
  return {
    async readBrowserOwner(threadId) {
      const rows = await db
        .select({ owner: thread.browserOwner })
        .from(thread)
        .where(eq(thread.id, threadId))
        .limit(1);

      return rows[0]?.owner ?? "agent";
    },

    async changeBrowserOwner({ userId, threadId, owner }) {
      await db.transaction(async (tx) => {
        const owners = await tx
          .select({ id: thread.id })
          .from(thread)
          .where(ownedThread(threadId, userId))
          .for("update")
          .limit(1);

        if (!owners[0]) throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);

        if (owner === "agent") {
          const pending = await tx
            .select()
            .from(questionRequest)
            .where(
              and(
                eq(questionRequest.threadId, threadId),
                eq(questionRequest.state, "pending"),
                eq(questionRequest.browserHandoff, true),
              ),
            )
            .limit(1);

          if (pending[0]) {
            const request = questionRequestSchema.parse(pending[0]);
            await answerQuestionInTransaction(tx, {
              userId,
              threadId,
              requestId: request.id,
              answers: Object.fromEntries(
                request.questions.map((question) => [question.id, "Done"]),
              ),
            });
          }
        }

        await setBrowserOwner(tx, threadId, owner);
      });
    },

    async recordBrowserActivity(threadId, active) {
      await db.transaction((tx) =>
        appendEvent(
          tx,
          threadId,
          active ? "browser.activity_started" : "browser.activity_stopped",
          {},
          `browser:activity:${randomUUID()}`,
        ),
      );
    },
  };
}
