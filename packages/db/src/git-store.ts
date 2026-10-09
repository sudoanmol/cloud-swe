import { z } from "zod";
import { proposalDigest } from "@cloud-swe/db/git-digest";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import {
  commandOperation,
  gitOperation,
  run,
  thread,
  threadEvent,
  workspace,
  outbox,
} from "./schema";
import { ThreadStoreError, type RunRecord } from "./thread-contracts";
import {
  threadPrSchema,
  type ThreadPr,
  gitOperationSchema,
  gitProposalSchema,
  type GitContext,
  type GitOperation,
  type GitProposal,
} from "./git-contracts";
import { jsonValueSchema, type JsonObject } from "./json";
import { activeRunStatuses, ownedThread, unsettledCommandStates } from "./threads/shared";
import { workspaceDiffStatSchema } from "./workspace-review";

type Db = NodePgDatabase<typeof schema>;

export type GitTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function gitError(code: string, status = 409): never {
  throw new ThreadStoreError(code, code, status);
}

export async function appendGitEvent(
  tx: GitTransaction,
  current: Pick<RunRecord, "threadId" | "id">,
  type: string,
  operationId: string,
  payload: JsonObject,
) {
  const [updated] = await tx
    .update(thread)
    .set({ eventSequence: sql`${thread.eventSequence} + 1` })
    .where(eq(thread.id, current.threadId))
    .returning();

  if (!updated) return gitError("THREAD_NOT_FOUND", 404);
  await tx.insert(threadEvent).values({
    threadId: current.threadId,
    sequence: updated.eventSequence,
    type,
    payload: { runId: current.id, operationId, ...payload },
    dedupeKey: `git:${operationId}:${type}:${updated.eventSequence}`,
  });
}

/** Called inside the checkpoint transaction after the common ownership locks. */
export async function publishGitProposal(
  tx: GitTransaction,
  current: RunRecord,
  generation: number,
  input: GitProposal,
  confirmed = false,
) {
  const proposal = gitProposalSchema.parse(input);

  if (proposalDigest(proposal) !== proposal.digest || current.cancelRequestedAt)
    gitError("GIT_PROPOSAL_STALE");
  const [prior] = await tx.select().from(gitOperation).where(eq(gitOperation.id, proposal.id));

  if (prior) {
    if (
      prior.runId !== current.id ||
      gitProposalSchema.parse(prior.proposal).digest !== proposal.digest
    )
      gitError("GIT_PROPOSAL_STALE");

    return;
  }

  if (current.approvalWaitStartedAt) gitError("GIT_APPROVAL_PENDING");
  const [repo] = await tx.select().from(thread).where(eq(thread.id, current.threadId));

  if (repo?.repositoryUrl !== proposal.repositoryUrl) gitError("GIT_PROPOSAL_STALE");
  await tx.insert(gitOperation).values({
    id: proposal.id,
    runId: current.id,
    threadId: current.threadId,
    userId: current.userId,
    generation,
    repositoryId: String(proposal.repositoryId),
    toolCallId: proposal.toolCallId,
    proposal,
    expiresAt: new Date(Date.now() + 86_400_000),
    ...(confirmed && { approval: "approved" as const, decidedAt: new Date() }),
  });

  if (confirmed) return;
  await tx.update(run).set({ approvalWaitStartedAt: new Date() }).where(eq(run.id, current.id));
  await appendGitEvent(tx, current, "git.approval.requested", proposal.id, {
    proposal,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
}

/** Thread -> workspace -> run is also the checkpoint and cancellation lock order. */
async function lockRun(tx: GitTransaction, runId: string) {
  const [identity] = await tx.select().from(run).where(eq(run.id, runId));

  if (!identity) return gitError("RUN_NOT_FOUND", 404);

  const [owner] = await tx
    .select()
    .from(thread)
    .where(eq(thread.id, identity.threadId))
    .for("update");

  const [sandbox] = await tx
    .select()
    .from(workspace)
    .where(eq(workspace.threadId, identity.threadId))
    .for("update");

  const [current] = await tx.select().from(run).where(eq(run.id, runId)).for("update");

  if (!current || !owner || !sandbox) return gitError("RUN_NOT_FOUND", 404);

  return { current, owner, sandbox };
}

export function createGitStore(db: Db) {
  async function context(input: GitContext) {
    return db.transaction(async (tx) => {
      const value = await lockRun(tx, input.runId);

      if (
        value.current.executionOwnerToken !== input.ownershipToken ||
        value.sandbox.generation !== input.generation ||
        value.current.executionOwnerGeneration !== input.generation
      )
        gitError("CHECKPOINT_OWNERSHIP_LOST");

      if (!["queued", "running"].includes(value.current.status) || value.current.cancelRequestedAt)
        gitError("RUN_TERMINAL");

      return { ...value, repositoryUrl: value.owner.repositoryUrl };
    });
  }

  async function read(id: string): Promise<GitOperation> {
    const [value] = await db.select().from(gitOperation).where(eq(gitOperation.id, id));

    if (!value) return gitError("GIT_OPERATION_NOT_FOUND", 404);

    return gitOperationSchema.parse(value);
  }

  async function settleApproval(
    tx: GitTransaction,
    current: RunRecord,
    op: GitOperation,
    approval: GitOperation["approval"],
  ) {
    await tx
      .update(gitOperation)
      .set({
        approval,
        decidedAt: new Date(),
        result: approval === "approved" ? null : { written: false, reason: approval },
      })
      .where(eq(gitOperation.id, op.id));
    await appendGitEvent(tx, current, "git.approval.decided", op.id, { approval });
    await tx.insert(outbox).values({
      threadId: current.threadId,
      runId: current.id,
      type: "git.decision",
    });
  }

  return {
    context,
    read,
    /** Header state for manual Git: thread ownership, idleness and the sandbox's last report. */
    async manualState(userId: string, threadId: string) {
      const [owner] = await db.select().from(thread).where(ownedThread(threadId, userId));

      if (!owner) return gitError("THREAD_NOT_FOUND", 404);
      const [ws] = await db.select().from(workspace).where(eq(workspace.threadId, threadId));

      const active = await db
        .select({ id: run.id })
        .from(run)
        .where(and(eq(run.threadId, threadId), inArray(run.status, [...activeRunStatuses])));

      const commands = ws
        ? await db
            .select({ id: commandOperation.commandId })
            .from(commandOperation)
            .where(
              and(
                eq(commandOperation.workspaceId, ws.id),
                inArray(commandOperation.state, [...unsettledCommandStates]),
              ),
            )
        : [];

      // A reset clears the report until the next count.
      const [latest] = await db
        .select({ type: threadEvent.type, payload: threadEvent.payload })
        .from(threadEvent)
        .where(
          and(
            eq(threadEvent.threadId, threadId),
            inArray(threadEvent.type, ["diff.updated", "workspace.reset"]),
          ),
        )
        .orderBy(desc(threadEvent.sequence))
        .limit(1);

      return {
        available: Boolean(
          owner.repositoryUrl &&
          ws &&
          !ws.lifecycleTransitionId &&
          !active.length &&
          !commands.length,
        ),
        title: owner.title,
        repositoryUrl: owner.repositoryUrl,
        base: owner.repositoryBranch,
        workspace:
          latest?.type === "diff.updated"
            ? (workspaceDiffStatSchema.safeParse(latest.payload).data ?? null)
            : null,
      };
    },
    async threadPullRequest(userId: string, threadId: string) {
      const [owner] = await db.select().from(thread).where(ownedThread(threadId, userId));

      if (!owner) return gitError("THREAD_NOT_FOUND", 404);

      const rows = await db
        .select()
        .from(gitOperation)
        .where(and(eq(gitOperation.threadId, threadId), eq(gitOperation.execution, "succeeded")))
        .orderBy(desc(gitOperation.createdAt), desc(gitOperation.id));

      // Once a creation establishes the PR, comments on other PRs cannot retarget the thread.
      const creation = rows.find(
        (row) => gitProposalSchema.parse(row.proposal).request.kind === "pr_create",
      );

      for (const row of creation ? [creation] : rows) {
        const op = gitOperationSchema.parse(row);
        const r = op.proposal.request;

        if (r.kind === "push") continue;
        const url = op.result?.url;

        const number =
          "number" in r
            ? r.number
            : (op.proposal.pullRequest?.number ??
              (z.url().safeParse(url).success
                ? Number(new URL(z.url().parse(url)).pathname.match(/\/pull\/(\d+)$/)?.[1])
                : undefined));

        if (number && owner.repositoryUrl)
          return { repositoryUrl: owner.repositoryUrl, number, cached: owner.pullRequest };
      }

      return null;
    },
    async savePullRequest(userId: string, threadId: string, value: ThreadPr) {
      await db
        .update(thread)
        .set({ pullRequest: threadPrSchema.parse(value) })
        .where(ownedThread(threadId, userId));
    },
    async unsettled() {
      return db
        .select({ id: gitOperation.id })
        .from(gitOperation)
        .where(inArray(gitOperation.execution, ["executing", "unknown"]));
    },
    async list(userId: string, threadId: string, page = 1) {
      const [owner] = await db.select().from(thread).where(ownedThread(threadId, userId));

      if (!owner) return gitError("THREAD_NOT_FOUND", 404);

      return gitOperationSchema.array().parse(
        await db
          .select()
          .from(gitOperation)
          .where(eq(gitOperation.threadId, threadId))
          .orderBy(desc(gitOperation.createdAt), desc(gitOperation.id))
          .limit(50)
          .offset((page - 1) * 50),
      );
    },
    async forRun(runId: string) {
      return gitOperationSchema
        .array()
        .parse(
          await db
            .select()
            .from(gitOperation)
            .where(eq(gitOperation.runId, runId))
            .orderBy(asc(gitOperation.createdAt), asc(gitOperation.id)),
        );
    },
    async decision(input: {
      userId: string;
      threadId: string;
      id: string;
      decision: "approve" | "reject";
      digest: string;
    }) {
      const identity = await read(input.id);

      if (identity.userId !== input.userId || identity.threadId !== input.threadId)
        gitError("GIT_OPERATION_NOT_FOUND", 404);
      await db.transaction(async (tx) => {
        const { current, sandbox } = await lockRun(tx, identity.runId);

        const [row] = await tx
          .select()
          .from(gitOperation)
          .where(eq(gitOperation.id, input.id))
          .for("update");

        const op = gitOperationSchema.parse(row);
        const approval = input.decision === "approve" ? "approved" : "rejected";

        if (op.proposal.digest !== input.digest) gitError("GIT_PROPOSAL_STALE");

        if (op.approval === approval) return;

        if (op.approval !== "pending") gitError("GIT_DECISION_CONFLICT");

        if (
          op.expiresAt.getTime() <= Date.now() ||
          current.cancelRequestedAt ||
          !["running", "queued"].includes(current.status) ||
          sandbox.generation !== op.generation
        )
          gitError("GIT_PROPOSAL_STALE");
        await settleApproval(tx, current, op, approval);
      });

      return read(input.id);
    },
    async expire(runId: string) {
      await db.transaction(async (tx) => {
        const { current, sandbox } = await lockRun(tx, runId);

        const rows = await tx
          .select()
          .from(gitOperation)
          .where(
            and(
              eq(gitOperation.runId, runId),
              inArray(gitOperation.approval, ["pending", "approved"]),
            ),
          );

        for (const row of rows) {
          const op = gitOperationSchema.parse(row);

          if (op.execution !== "not_started") continue;

          if (
            current.cancelRequestedAt ||
            !["queued", "running"].includes(current.status) ||
            op.generation !== sandbox.generation
          )
            await settleApproval(tx, current, op, "invalidated");
          else if (op.expiresAt.getTime() <= Date.now())
            await settleApproval(tx, current, op, "expired");
        }
      });
    },
    async resume(runId: string) {
      await db.transaction(async (tx) => {
        const { current } = await lockRun(tx, runId);

        const [pending] = await tx
          .select()
          .from(gitOperation)
          .where(and(eq(gitOperation.runId, runId), eq(gitOperation.approval, "pending")));

        if (pending) gitError("GIT_APPROVAL_PENDING");

        if (current.approvalWaitStartedAt)
          await tx
            .update(run)
            .set({
              approvalWaitMs:
                current.approvalWaitMs +
                Math.max(0, Date.now() - current.approvalWaitStartedAt.getTime()),
              approvalWaitStartedAt: null,
            })
            .where(eq(run.id, runId));
      });
    },
    async claim(id: string, input: GitContext) {
      return db.transaction(async (tx) => {
        const { current, sandbox } = await lockRun(tx, input.runId);

        const [row] = await tx
          .select()
          .from(gitOperation)
          .where(eq(gitOperation.id, id))
          .for("update");

        const op = gitOperationSchema.parse(row);

        if (
          op.runId !== current.id ||
          current.executionOwnerToken !== input.ownershipToken ||
          sandbox.generation !== input.generation
        )
          gitError("CHECKPOINT_OWNERSHIP_LOST");

        if (op.execution !== "not_started") return { operation: op, dispatch: false };

        if (
          current.cancelRequestedAt ||
          !["running", "queued"].includes(current.status) ||
          op.generation !== sandbox.generation ||
          op.approval !== "approved" ||
          op.expiresAt.getTime() <= Date.now()
        )
          gitError("GIT_PROPOSAL_STALE");
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`git-repository:${op.proposal.repositoryId}`}, 0))`,
        );

        const [unsettled] = await tx
          .select()
          .from(gitOperation)
          .where(
            and(
              eq(gitOperation.repositoryId, String(op.proposal.repositoryId)),
              inArray(gitOperation.execution, ["executing", "unknown"]),
            ),
          );

        if (unsettled) gitError("GIT_OPERATION_UNKNOWN");
        await tx
          .update(gitOperation)
          .set({ execution: "executing" })
          .where(eq(gitOperation.id, id));
        await appendGitEvent(tx, current, "git.operation.updated", id, { execution: "executing" });

        return { operation: op, dispatch: true };
      });
    },
    async finish(
      id: string,
      execution: "succeeded" | "failed" | "unknown",
      result: JsonObject,
      expectedExecution?: "not_started",
    ) {
      const safeResult = jsonValueSchema.parse(JSON.parse(JSON.stringify(result)));
      const identity = await read(id);
      await db.transaction(async (tx) => {
        const { current } = await lockRun(tx, identity.runId);

        const [row] = await tx
          .select()
          .from(gitOperation)
          .where(eq(gitOperation.id, id))
          .for("update");

        const op = gitOperationSchema.parse(row);

        if (op.execution === "succeeded" || op.execution === "failed") return;

        if (expectedExecution && op.execution !== expectedExecution) return;
        await tx
          .update(gitOperation)
          .set({ execution, result: safeResult })
          .where(eq(gitOperation.id, id));
        await appendGitEvent(tx, current, "git.operation.updated", id, {
          execution,
          result: safeResult,
        });
      });

      return read(id);
    },
  };
}

export type GitStore = ReturnType<typeof createGitStore>;
