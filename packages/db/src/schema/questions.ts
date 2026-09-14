import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type { QuestionAnswers, QuestionRequestPayload } from "../question-contracts";
import { user } from "./auth";
import { run, thread } from "./threads";

export const questionRequest = pgTable(
  "question_request",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    toolCallId: text("tool_call_id").notNull(),
    questions: jsonb("questions").$type<QuestionRequestPayload["questions"]>().notNull(),
    state: text("state").notNull().default("pending"),
    answers: jsonb("answers").$type<QuestionAnswers>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("question_request_tool_idx").on(table.runId, table.toolCallId),
    uniqueIndex("question_request_pending_run_idx")
      .on(table.runId)
      .where(sql`${table.state} = 'pending'`),
    index("question_request_thread_idx").on(table.threadId, table.createdAt),
    check(
      "question_request_state_check",
      sql`${table.state} in ('pending','answered','cancelled')`,
    ),
  ],
);
