import { relations, sql } from "drizzle-orm";
import {
  date,
  doublePrecision,
  integer,
  jsonb,
  boolean,
  pgTable,
  text,
  timestamp,
  uuid,
  index,
  uniqueIndex,
  check,
  primaryKey,
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
    repositoryUrl: text("repository_url"),
    repositoryBranch: text("repository_branch"),
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
    accessPolicy: text("access_policy", { enum: ["owner", "demo"] })
      .notNull()
      .default("demo"),
    agentStartedAt: timestamp("agent_started_at", { withTimezone: true }),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    executionOwnerAttemptId: text("execution_owner_attempt_id"),
    executionOwnerToken: uuid("execution_owner_token"),
    executionOwnerGeneration: integer("execution_owner_generation"),
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
    check("run_access_policy_check", sql`${table.accessPolicy} in ('owner', 'demo')`),
    check(
      "run_status_check",
      sql`${table.status} in ('queued', 'running', 'completed', 'failed', 'cancelled')`,
    ),
  ],
);

/** Historical claims prevent an old activity attempt from reclaiming a run after replacement. */
export const runExecutionOwner = pgTable(
  "run_execution_owner",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    attemptId: text("attempt_id").notNull(),
    token: uuid("token").defaultRandom().notNull().unique(),
    generation: integer("generation").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.attemptId] }),
    check("run_execution_owner_generation_check", sql`${table.generation} >= 1`),
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
    name: text("name").notNull().unique(),
    provider: text("provider", { enum: ["docker", "freestyle"] })
      .notNull()
      .default("docker"),
    state: text("state", {
      enum: ["provisioning", "running", "paused", "deleted", "failed", "quarantined", "recovery"],
    }).notNull(),
    providerId: text("provider_id"),
    generation: integer("generation").default(1).notNull(),
    lifecycleTransitionId: uuid("lifecycle_transition_id"),
    lifecycleTransitionState: text("lifecycle_transition_state", {
      enum: ["provisioning", "running", "paused", "deleted", "failed", "quarantined", "recovery"],
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("workspace_provider_check", sql`${table.provider} in ('docker', 'freestyle')`),
    check(
      "workspace_state_check",
      sql`${table.state} in ('provisioning', 'running', 'paused', 'deleted', 'failed', 'quarantined', 'recovery')`,
    ),
    check("workspace_generation_check", sql`${table.generation} >= 1`),
    check(
      "workspace_transition_state_check",
      sql`${table.lifecycleTransitionState} is null or ${table.lifecycleTransitionState} in ('provisioning', 'running', 'paused', 'deleted', 'failed', 'quarantined', 'recovery')`,
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
    key: text("key").notNull(),
    generation: integer("generation").default(1).notNull(),
    attemptId: text("attempt_id"),
    content: jsonb("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("agent_checkpoint_run_key_idx").on(table.runId, table.key),
    index("agent_checkpoint_generation_idx").on(table.runId, table.generation),
    check("agent_checkpoint_generation_check", sql`${table.generation} >= 1`),
  ],
);

export const agentCheckpointEntry = pgTable(
  "agent_checkpoint_entry",
  {
    checkpointId: uuid("checkpoint_id")
      .notNull()
      .references(() => agentCheckpoint.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    content: jsonb("content").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.checkpointId, table.ordinal] }),
    check("agent_checkpoint_entry_ordinal_check", sql`${table.ordinal} >= 0`),
  ],
);

export const commandOperation = pgTable(
  "command_operation",
  {
    commandId: uuid("command_id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    generation: integer("generation").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    attemptId: text("attempt_id").notNull(),
    state: text("state", {
      enum: ["pending", "running", "completed", "failed", "unknown"],
    })
      .notNull()
      .default("pending"),
    cancellationRequested: boolean("cancellation_requested").notNull().default(false),
    metadata: jsonb("metadata").notNull().default({}),
    result: jsonb("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("command_operation_unsettled_workspace_generation_idx")
      .on(table.workspaceId, table.generation)
      .where(sql`${table.state} in ('pending', 'running', 'unknown')`),
    index("command_operation_workspace_generation_idx").on(table.workspaceId, table.generation),
    index("command_operation_run_idx").on(table.runId),
    check("command_operation_generation_check", sql`${table.generation} >= 1`),
    check(
      "command_operation_state_check",
      sql`${table.state} in ('pending', 'running', 'completed', 'failed', 'unknown')`,
    ),
  ],
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
  commandOperations: many(commandOperation),
}));

export const workspaceRelations = relations(workspace, ({ one, many }) => ({
  thread: one(thread, { fields: [workspace.threadId], references: [thread.id] }),
  commandOperations: many(commandOperation),
}));

export const commandOperationRelations = relations(commandOperation, ({ one }) => ({
  workspace: one(workspace, { fields: [commandOperation.workspaceId], references: [workspace.id] }),
  run: one(run, { fields: [commandOperation.runId], references: [run.id] }),
}));

/** One lifetime turn reservation per submitted demo run. */
export const demoTurn = pgTable(
  "demo_turn",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(() => run.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    state: text("state", { enum: ["reserved", "consumed", "released"] }).notNull(),
  },
  (table) => [
    index("demo_turn_user_idx").on(table.userId),
    check("demo_turn_state_check", sql`${table.state} in ('reserved', 'consumed', 'released')`),
  ],
);

export const demoComputeReservation = pgTable(
  "demo_compute_reservation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id),
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id),
    providerId: text("provider_id"),
    reservedSeconds: doublePrecision("reserved_seconds").notNull(),
    latestStartAt: timestamp("latest_start_at", { withTimezone: true }),
    observedSeconds: doublePrecision("observed_seconds").notNull().default(0),
    baselineSeconds: doublePrecision("baseline_seconds").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    consumedSeconds: doublePrecision("consumed_seconds"),
  },
  (table) => [
    uniqueIndex("demo_compute_unbound_workspace_idx")
      .on(table.workspaceId)
      .where(sql`${table.settledAt} is null and ${table.providerId} is null`),
    uniqueIndex("demo_compute_run_provider_idx")
      .on(table.runId, table.workspaceId, table.providerId)
      .where(sql`${table.providerId} is not null`),
    check("demo_compute_reserved_positive", sql`${table.reservedSeconds} > 0`),
    check("demo_compute_baseline_nonnegative", sql`${table.baselineSeconds} >= 0`),
    check("demo_compute_consumed_nonnegative", sql`${table.consumedSeconds} >= 0`),
  ],
);

export const demoComputeUsage = pgTable(
  "demo_compute_usage",
  {
    month: date("month").primaryKey(),
    seconds: doublePrecision("seconds").notNull(),
  },
  (table) => [check("demo_compute_usage_nonnegative", sql`${table.seconds} >= 0`)],
);

export const demoComputeMonthAllocation = pgTable(
  "demo_compute_month_allocation",
  {
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => demoComputeReservation.id, { onDelete: "cascade" }),
    month: date("month").notNull(),
    consumed: doublePrecision("consumed").notNull(),
    reserved: doublePrecision("reserved").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.reservationId, table.month] }),
    check("demo_compute_month_consumed_nonnegative", sql`${table.consumed} >= 0`),
    check("demo_compute_month_reserved_nonnegative", sql`${table.reserved} >= 0`),
  ],
);
