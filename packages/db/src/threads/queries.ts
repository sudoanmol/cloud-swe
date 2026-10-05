import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { attachment, message, run, thread, threadEvent, workspace } from "../schema/threads";
import { publicAttachment } from "./attachments";
import { ThreadStoreError, type ThreadStore, type ThreadView } from "../thread-contracts";

import { workspaceDiffStatSchema } from "../workspace-review";
import { ownedThread, type Db } from "./shared";

export function createQueriesStore(
  db: Db,
): Pick<ThreadStore, "listThreads" | "getThread" | "authorizeThread" | "listEvents"> {
  return {
    async listThreads({ userId, limit = 51, before }) {
      // JavaScript cursors retain milliseconds; order at the same precision as the cursor.
      const updatedAt = sql`date_trunc('milliseconds', ${thread.updatedAt})`;

      const rows = await db
        .select({
          id: thread.id,
          title: thread.title,
          repositoryUrl: thread.repositoryUrl,
          repositoryBranch: thread.repositoryBranch,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          runStatus: sql<
            import("../thread-contracts").RunStatus | null
          >`(select status from run where run.thread_id = ${thread.id} order by created_at desc, id desc limit 1)`,
          workspaceState: workspace.state,
          // A reset clears the count, matching the thread view's projection.
          diffStat: sql<unknown>`(select case when e.type = 'diff.updated' then e.payload end from thread_event e where e.thread_id = ${thread.id} and e.type in ('diff.updated', 'workspace.reset') order by e.sequence desc limit 1)`,
        })
        .from(thread)
        .leftJoin(workspace, eq(workspace.threadId, thread.id))
        .where(
          and(
            eq(thread.userId, userId),
            isNull(thread.deletedAt),
            before
              ? sql`(${updatedAt}, ${thread.id}) < (${before.updatedAt.toISOString()}::timestamptz, ${before.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(updatedAt), desc(thread.id))
        .limit(Math.min(101, Math.max(1, limit)));

      return rows.map((row) => ({
        ...row,
        diffStat: workspaceDiffStatSchema.safeParse(row.diffStat).data ?? null,
      }));
    },
    async getThread({ userId, threadId }) {
      return db.transaction(
        async (tx) => {
          const owned = await tx
            .select()
            .from(thread)
            .where(ownedThread(threadId, userId))
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

          const publicRuns: import("../thread-contracts").PublicRun[] = runs.map((currentRun) => ({
            id: currentRun.id,
            status: currentRun.status,
            prompt: currentRun.prompt,
            modelSelection: currentRun.modelSelection ? { ...currentRun.modelSelection } : null,
            cancelRequestedAt: currentRun.cancelRequestedAt,
            approvalWaitStartedAt: currentRun.approvalWaitStartedAt,
            questionWaitStartedAt: currentRun.questionWaitStartedAt,
            startedAt: currentRun.startedAt,
            completedAt: currentRun.completedAt,
            createdAt: currentRun.createdAt,
            error: currentRun.error,
          }));

          const currentWorkspace = ws[0];

          const view: ThreadView = {
            id: currentThread.id,
            userId: currentThread.userId,
            title: currentThread.title,
            repositoryUrl: currentThread.repositoryUrl,
            repositoryBranch: currentThread.repositoryBranch,
            createdAt: currentThread.createdAt,
            updatedAt: currentThread.updatedAt,
            messages: messages.map((item) => ({
              id: item.id,
              runId: item.runId,
              role: item.role,
              content: item.content,
              clientMessageId: item.clientMessageId,
              createdAt: item.createdAt,
              attachments: (attachmentsByMessage.get(item.id) ?? []).map((row) =>
                publicAttachment(row.attachment),
              ),
            })),
            runs: publicRuns,
            workspace: currentWorkspace
              ? {
                  id: currentWorkspace.id,
                  state: currentWorkspace.state,
                  provider: currentWorkspace.provider,
                  generation: currentWorkspace.generation,
                  updatedAt: currentWorkspace.updatedAt,
                }
              : null,
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
        .where(ownedThread(threadId, userId))
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
