import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { run, thread } from "./threads";
import { user } from "./auth";

export const gitOperation = pgTable(
  "git_operation",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => thread.id),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    generation: integer("generation").notNull(),
    repositoryId: text("repository_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    proposal: jsonb("proposal").notNull(),
    approval: text("approval").notNull().default("pending"),
    execution: text("execution").notNull().default("not_started"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    result: jsonb("result"),
  },
  (t) => [
    check("git_operation_generation_check", sql`${t.generation} > 0`),
    uniqueIndex("git_operation_tool_idx").on(t.runId, t.toolCallId),
    uniqueIndex("git_operation_pending_run_idx")
      .on(t.runId)
      .where(sql`${t.approval} = 'pending'`),
    uniqueIndex("git_operation_unsettled_repo_idx")
      .on(t.repositoryId)
      .where(sql`${t.execution} in ('executing','unknown')`),
    index("git_operation_thread_idx").on(t.threadId, t.createdAt),
    check(
      "git_operation_approval_check",
      sql`${t.approval} in ('pending','approved','rejected','expired','invalidated')`,
    ),
    check(
      "git_operation_execution_check",
      sql`${t.execution} in ('not_started','executing','succeeded','failed','unknown')`,
    ),
  ],
);
