import { sql } from "drizzle-orm";
import {
  doublePrecision,
  integer,
  bigserial,
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
    /** At-most-once claim timestamp for best-effort title generation. */
    titleGenerationStartedAt: timestamp("title_generation_started_at", { withTimezone: true }),
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

export const attachment = pgTable(
  "attachment",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => message.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal"),
    filename: text("filename").notNull(),
    detectedMimeType: text("detected_mime_type").notNull().default("application/octet-stream"),
    classification: text("classification", { enum: ["image", "file"] }).notNull(),
    state: text("state", { enum: ["uploading", "ready", "failed", "deleting"] })
      .notNull()
      .default("uploading"),
    originalSha256: text("original_sha256"),
    originalSize: integer("original_size"),
    modelSha256: text("model_sha256"),
    modelMimeType: text("model_mime_type"),
    modelSize: integer("model_size"),
    modelWidth: integer("model_width"),
    modelHeight: integer("model_height"),
    storageBytes: integer("storage_bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("attachment_user_created_idx").on(table.userId, table.createdAt),
    uniqueIndex("attachment_message_ordinal_idx").on(table.messageId, table.ordinal),
    check("attachment_ordinal_check", sql`${table.ordinal} is null or ${table.ordinal} >= 0`),
    check(
      "attachment_original_size_check",
      sql`${table.originalSize} is null or ${table.originalSize} >= 0`,
    ),
    check(
      "attachment_model_size_check",
      sql`${table.modelSize} is null or ${table.modelSize} >= 0`,
    ),
    check("attachment_storage_bytes_check", sql`${table.storageBytes} >= 0`),
    check("attachment_classification_check", sql`${table.classification} in ('image', 'file')`),
    check(
      "attachment_state_check",
      sql`${table.state} in ('uploading', 'ready', 'failed', 'deleting')`,
    ),
    check(
      "attachment_binding_check",
      sql`(${table.messageId} is null and ${table.ordinal} is null) or (${table.messageId} is not null and ${table.ordinal} is not null)`,
    ),
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
    modelSelection: jsonb("model_selection").$type<import("../model-selection").ModelSelection>(),
    accessPolicy: text("access_policy", { enum: ["owner", "demo"] })
      .notNull()
      .default("demo"),
    agentStartedAt: timestamp("agent_started_at", { withTimezone: true }),
    approvalWaitStartedAt: timestamp("approval_wait_started_at", { withTimezone: true }),
    approvalWaitMs: doublePrecision("approval_wait_ms").notNull().default(0),
    questionWaitStartedAt: timestamp("question_wait_started_at", { withTimezone: true }),
    questionWaitMs: doublePrecision("question_wait_ms").notNull().default(0),
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
    check("run_approval_wait_ms_check", sql`${table.approvalWaitMs} >= 0`),
    check("run_question_wait_ms_check", sql`${table.questionWaitMs} >= 0`),
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
    provider: text("provider", { enum: ["docker", "modal"] })
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
    /** Last review panel read; it defers the idle pause like agent work. */
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("workspace_provider_check", sql`${table.provider} in ('docker', 'modal')`),
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
    access: text("access", { enum: ["exclusive", "read"] })
      .notNull()
      .default("exclusive"),
    readSlot: integer("read_slot"),
    ownershipToken: uuid("ownership_token"),
    queueOrder: bigserial("queue_order", { mode: "number" }).notNull(),
    state: text("state", {
      enum: ["queued", "pending", "running", "completed", "failed", "unknown"],
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
    check("command_operation_access_check", sql`${table.access} in ('exclusive', 'read')`),
    check(
      "command_operation_read_slot_check",
      sql`(${table.access} = 'exclusive' and ${table.readSlot} is null) or (${table.access} = 'read' and ((${table.state} in ('queued', 'completed', 'failed') and ${table.readSlot} is null) or (${table.readSlot} is not null and ${table.readSlot} between 1 and 4)))`,
    ),
    index("command_operation_workspace_generation_idx").on(table.workspaceId, table.generation),
    index("command_operation_run_idx").on(table.runId),
    check("command_operation_generation_check", sql`${table.generation} >= 1`),
    check(
      "command_operation_state_check",
      sql`${table.state} in ('queued', 'pending', 'running', 'completed', 'failed', 'unknown')`,
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
    type: text("type", {
      enum: ["run.requested", "run.cancel", "git.decision", "questions.answer", "workspace.wake"],
    }).notNull(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    /** Null for thread-level signals such as `workspace.wake`. */
    runId: uuid("run_id").references(() => run.id, { onDelete: "cascade" }),
    attempts: integer("attempts").default(0).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("outbox_pending_idx").on(table.availableAt, table.deliveredAt)],
);

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
