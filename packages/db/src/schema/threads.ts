import { relations, sql } from "drizzle-orm";
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

export const thread = pgTable(
  "thread",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title"),
    eventSequence: integer("event_sequence").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [check("thread_event_sequence_check", sql`${table.eventSequence} >= 0`)],
);

export const message = pgTable(
  "message",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => run.id, { onDelete: "set null" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
    content: text("content").notNull(),
    clientMessageId: text("client_message_id"),
    requestKind: text("request_kind", { enum: ["initial", "followup"] })
      .default("followup")
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("message_thread_created_idx").on(table.threadId, table.createdAt),
    uniqueIndex("message_user_client_id_idx").on(table.userId, table.clientMessageId),
    check("message_request_kind_check", sql`${table.requestKind} in ('initial', 'followup')`),
  ],
);

export const run = pgTable(
  "run",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["queued", "running", "completed", "failed", "cancelled"],
    }).notNull(),
    prompt: text("prompt").notNull(),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("run_user_status_idx").on(table.userId, table.status),
    index("run_thread_created_idx").on(table.threadId, table.createdAt),
    uniqueIndex("run_one_active_thread_idx")
      .on(table.threadId)
      .where(sql`${table.status} in ('queued', 'running')`),
    uniqueIndex("run_one_active_user_idx")
      .on(table.userId)
      .where(sql`${table.status} in ('queued', 'running')`),
    check(
      "run_status_check",
      sql`${table.status} in ('queued', 'running', 'completed', 'failed', 'cancelled')`,
    ),
  ],
);

export const workspace = pgTable(
  "workspace",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .unique()
      .references(() => thread.id, { onDelete: "cascade" }),
    dockerName: text("docker_name").notNull().unique(),
    provider: text("provider", { enum: ["docker", "freestyle"] })
      .notNull()
      .default("docker"),
    state: text("state", {
      enum: ["provisioning", "running", "paused", "deleted", "failed"],
    }).notNull(),
    providerId: text("provider_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("workspace_provider_check", sql`${table.provider} in ('docker', 'freestyle')`),
    check(
      "workspace_state_check",
      sql`${table.state} in ('provisioning', 'running', 'paused', 'deleted', 'failed')`,
    ),
  ],
);

export const agentCheckpoint = pgTable(
  "agent_checkpoint",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    step: integer("step").notNull(),
    content: jsonb("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("agent_checkpoint_run_step_idx").on(table.runId, table.step)],
);

export const threadEvent = pgTable(
  "thread_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("thread_event_sequence_idx").on(table.threadId, table.sequence),
    uniqueIndex("thread_event_dedupe_idx").on(table.threadId, table.dedupeKey),
  ],
);

export const outbox = pgTable(
  "outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: text("type", { enum: ["run.requested", "run.cancel"] }).notNull(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    payload: jsonb("payload").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("outbox_pending_idx").on(table.availableAt, table.deliveredAt)],
);

export const threadRelations = relations(thread, ({ many, one }) => ({
  user: one(user, { fields: [thread.userId], references: [user.id] }),
  messages: many(message),
  runs: many(run),
  events: many(threadEvent),
  workspace: one(workspace),
}));
export const runRelations = relations(run, ({ one, many }) => ({
  thread: one(thread, { fields: [run.threadId], references: [thread.id] }),
  checkpoints: many(agentCheckpoint),
}));
