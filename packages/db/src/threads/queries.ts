import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { attachment, message, run, thread, threadEvent, workspace } from "../schema/threads";
import { publicAttachment } from "./attachments";
import { ThreadStoreError, type ThreadStore, type ThreadView } from "../thread-contracts";

import { type Db } from "./shared";

export function createQueriesStore(
  db: Db,
): Pick<ThreadStore, "listThreads" | "getThread" | "authorizeThread" | "listEvents"> {
  return {
    async listThreads({ userId, limit = 51, before }) {
      // JavaScript cursors retain milliseconds; order at the same precision as the cursor.
      const createdAt = sql`date_trunc('milliseconds', ${thread.createdAt})`;

      return db
        .select({
          id: thread.id,
          title: thread.title,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          runStatus: sql<
            import("../thread-contracts").RunStatus | null
          >`(select status from run where run.thread_id = ${thread.id} order by created_at desc, id desc limit 1)`,
          workspaceState: workspace.state,
        })
        .from(thread)
        .leftJoin(workspace, eq(workspace.threadId, thread.id))
        .where(
          and(
            eq(thread.userId, userId),
            before
              ? sql`(${createdAt}, ${thread.id}) < (${before.createdAt.toISOString()}::timestamptz, ${before.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(createdAt), desc(thread.id))
        .limit(Math.min(101, Math.max(1, limit)));
    },
    async getThread({ userId, threadId }) {
      return db.transaction(
        async (tx) => {
          const owned = await tx
            .select()
            .from(thread)
            .where(and(eq(thread.id, threadId), eq(thread.userId, userId)))
            .limit(1);

          const currentThread = owned[0];

          if (!currentThread)
            throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);

          const messages = await tx
            .select()
            .from(message)
            .where(eq(message.threadId, threadId))
            .orderBy(asc(message.createdAt));

          const attachments = await tx
            .select()
            .from(attachment)
            .innerJoin(message, eq(attachment.messageId, message.id))
            .where(eq(message.threadId, threadId))
            .orderBy(asc(message.createdAt), asc(attachment.ordinal));

          const attachmentsByMessage = Map.groupBy(attachments, (item) => item.message.id);

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

          const publicRuns = runs.map((currentRun) => {
            const {
              executionOwnerAttemptId: _executionOwnerAttemptId,
              executionOwnerToken: _executionOwnerToken,
              executionOwnerGeneration: _executionOwnerGeneration,
              ...publicRun
            } = currentRun;

            return publicRun;
          });

          const view: ThreadView = {
            id: currentThread.id,
            userId: currentThread.userId,
            title: currentThread.title,
            repositoryUrl: currentThread.repositoryUrl,
            repositoryBranch: currentThread.repositoryBranch,
            messages: messages.map((item) => ({
              ...item,
              attachments: (attachmentsByMessage.get(item.id) ?? []).map((row) =>
                publicAttachment(row.attachment),
              ),
            })),
            runs: publicRuns,
            workspace: ws[0] ?? null,
            latestEventId: currentThread.eventSequence || null,
          };

          return view;
        },
        { isolationLevel: "repeatable read" },
      );
    },

    async authorizeThread({ userId, threadId }) {
      const owned = await db
        .select({ id: thread.id })
        .from(thread)
        .where(and(eq(thread.id, threadId), eq(thread.userId, userId)))
        .limit(1);

      if (!owned[0]) throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);
    },

    async listEvents({ threadId, after, limit = 100 }) {
      const rows = await db
        .select()
        .from(threadEvent)
        .where(
          after === undefined
            ? eq(threadEvent.threadId, threadId)
            : and(eq(threadEvent.threadId, threadId), gt(threadEvent.sequence, after)),
        )
        .orderBy(asc(threadEvent.sequence))
        .limit(Math.min(Math.max(limit, 1), 500));

      return rows;
    },
  };
}
