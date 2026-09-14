import { and, asc, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { isDeepStrictEqual } from "node:util";

import { jsonValueSchema } from "./json";
import {
  questionAnswersSchema,
  questionRequestPayloadSchema,
  questionRequestSchema,
  type QuestionAnswers,
  type QuestionRequestPayload,
} from "./question-contracts";
import * as schema from "./schema";
import { outbox, run, thread } from "./schema/threads";
import { questionRequest } from "./schema/questions";
import { ThreadStoreError, type RunRecord } from "./thread-contracts";
import { appendEvent, isActiveRun, type Tx } from "./threads/shared";

type Db = NodePgDatabase<typeof schema>;

function questionError(code: string, message: string, status = 409): never {
  throw new ThreadStoreError(code, message, status);
}

function sameRequest(
  row: { id: string; toolCallId: string; questions: unknown },
  request: QuestionRequestPayload,
): boolean {
  return (
    row.id === request.id &&
    row.toolCallId === request.toolCallId &&
    isDeepStrictEqual(row.questions, request.questions)
  );
}

/** Called inside the checkpoint transaction after the common ownership locks. */
export async function publishQuestionRequest(
  tx: Tx,
  current: RunRecord,
  input: QuestionRequestPayload,
): Promise<void> {
  const request = questionRequestPayloadSchema.parse(input);

  if (current.cancelRequestedAt || !isActiveRun(current.status))
    questionError("QUESTION_REQUEST_STALE", "The question request is no longer active");

  const prior = await tx
    .select()
    .from(questionRequest)
    .where(
      and(
        eq(questionRequest.runId, current.id),
        eq(questionRequest.toolCallId, request.toolCallId),
      ),
    )
    .limit(1);

  if (prior[0]) {
    if (!sameRequest(prior[0], request))
      questionError("QUESTION_REQUEST_STALE", "The question request changed");

    return;
  }

  if (current.questionWaitStartedAt)
    questionError("QUESTION_PENDING", "This run is already waiting for answers");

  if (current.approvalWaitStartedAt)
    questionError("GIT_APPROVAL_PENDING", "This run is waiting for Git approval");

  await tx.insert(questionRequest).values({
    id: request.id,
    runId: current.id,
    threadId: current.threadId,
    userId: current.userId,
    toolCallId: request.toolCallId,
    questions: request.questions,
  });
  await tx.update(run).set({ questionWaitStartedAt: new Date() }).where(eq(run.id, current.id));
  await appendEvent(
    tx,
    current.threadId,
    "questions.requested",
    { runId: current.id, requestId: request.id, request: jsonValueSchema.parse(request) },
    `questions:${request.id}:requested`,
  );
}

export async function cancelPendingQuestions(tx: Tx, current: RunRecord): Promise<void> {
  const cancelled = await tx
    .update(questionRequest)
    .set({ state: "cancelled", cancelledAt: new Date() })
    .where(and(eq(questionRequest.runId, current.id), eq(questionRequest.state, "pending")))
    .returning({ id: questionRequest.id });

  for (const request of cancelled)
    await appendEvent(
      tx,
      current.threadId,
      "questions.cancelled",
      { runId: current.id, requestId: request.id },
      `questions:${request.id}:cancelled`,
    );
}

export function createQuestionStore(db: Db) {
  async function readQuestionRequest(id: string) {
    const rows = await db.select().from(questionRequest).where(eq(questionRequest.id, id)).limit(1);

    if (!rows[0]) questionError("QUESTION_REQUEST_NOT_FOUND", "Question request not found", 404);

    return questionRequestSchema.parse(rows[0]);
  }

  return {
    readQuestionRequest,
    async listQuestionRequests(input: { userId: string; threadId: string }) {
      const owners = await db
        .select({ id: thread.id })
        .from(thread)
        .where(and(eq(thread.id, input.threadId), eq(thread.userId, input.userId)))
        .limit(1);

      if (!owners[0]) questionError("THREAD_NOT_FOUND", "Thread not found", 404);

      return questionRequestSchema
        .array()
        .parse(
          await db
            .select()
            .from(questionRequest)
            .where(eq(questionRequest.threadId, input.threadId))
            .orderBy(desc(questionRequest.createdAt), desc(questionRequest.id)),
        );
    },
    async pendingQuestionRequest(runId: string) {
      const rows = await db
        .select()
        .from(questionRequest)
        .where(and(eq(questionRequest.runId, runId), eq(questionRequest.state, "pending")))
        .orderBy(asc(questionRequest.createdAt))
        .limit(1);

      return rows[0] ? questionRequestSchema.parse(rows[0]) : null;
    },
    async answerQuestionRequest(input: {
      userId: string;
      threadId: string;
      requestId: string;
      answers: QuestionAnswers;
    }) {
      const answers = questionAnswersSchema.parse(input.answers);

      await db.transaction(async (tx) => {
        const owners = await tx
          .select({ id: thread.id })
          .from(thread)
          .where(and(eq(thread.id, input.threadId), eq(thread.userId, input.userId)))
          .for("update")
          .limit(1);

        if (!owners[0])
          questionError("QUESTION_REQUEST_NOT_FOUND", "Question request not found", 404);

        const rows = await tx
          .select()
          .from(questionRequest)
          .where(
            and(
              eq(questionRequest.id, input.requestId),
              eq(questionRequest.threadId, input.threadId),
              eq(questionRequest.userId, input.userId),
            ),
          )
          .for("update")
          .limit(1);

        if (!rows[0])
          questionError("QUESTION_REQUEST_NOT_FOUND", "Question request not found", 404);
        const request = questionRequestSchema.parse(rows[0]);
        const answerIds = Object.keys(answers).sort();
        const questionIds = request.questions.map(({ id }) => id).sort();

        if (
          answerIds.length !== questionIds.length ||
          answerIds.some((id, index) => id !== questionIds[index])
        )
          questionError("INVALID_QUESTION_ANSWERS", "Every question requires one answer", 400);
        const normalizedAnswers: QuestionAnswers = {};

        for (const question of request.questions) {
          const answer = answers[question.id];

          if (!answer)
            questionError("INVALID_QUESTION_ANSWERS", "Every question requires one answer", 400);
          normalizedAnswers[question.id] = answer;
        }

        if (request.state === "answered") {
          if (!isDeepStrictEqual(request.answers, normalizedAnswers))
            questionError("QUESTION_ANSWER_CONFLICT", "This request already has different answers");

          return;
        }

        if (request.state !== "pending")
          questionError("QUESTION_ANSWER_CONFLICT", "This question request was cancelled");
        const runs = await tx.select().from(run).where(eq(run.id, request.runId)).for("update");
        const current = runs[0];

        if (!current || !isActiveRun(current.status) || current.cancelRequestedAt)
          questionError("QUESTION_ANSWER_CONFLICT", "This question request is no longer active");
        await tx
          .update(questionRequest)
          .set({ state: "answered", answers: normalizedAnswers, answeredAt: new Date() })
          .where(eq(questionRequest.id, request.id));
        await appendEvent(
          tx,
          current.threadId,
          "questions.answered",
          { runId: current.id, requestId: request.id, answers: normalizedAnswers },
          `questions:${request.id}:answered`,
        );
        await tx.insert(outbox).values({
          threadId: current.threadId,
          runId: current.id,
          type: "questions.answer",
        });
      });

      return readQuestionRequest(input.requestId);
    },
    async resumeQuestionWait(runId: string) {
      await db.transaction(async (tx) => {
        const runs = await tx.select().from(run).where(eq(run.id, runId)).for("update").limit(1);
        const current = runs[0];

        if (!current) questionError("RUN_NOT_FOUND", "Run not found", 404);

        const pending = await tx
          .select({ id: questionRequest.id })
          .from(questionRequest)
          .where(and(eq(questionRequest.runId, runId), eq(questionRequest.state, "pending")))
          .limit(1);

        if (pending[0]) questionError("QUESTION_PENDING", "This run is waiting for answers");

        if (current.questionWaitStartedAt)
          await tx
            .update(run)
            .set({
              questionWaitMs:
                current.questionWaitMs +
                Math.max(0, Date.now() - current.questionWaitStartedAt.getTime()),
              questionWaitStartedAt: null,
            })
            .where(eq(run.id, runId));
      });
    },
  };
}

export type QuestionStore = ReturnType<typeof createQuestionStore>;
