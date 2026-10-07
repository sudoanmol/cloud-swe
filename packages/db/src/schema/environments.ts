import { sql } from "drizzle-orm";
import {
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

/**
 * A user's named set of variables for workspace commands. Code calls it an
 * "env set" so it never mixes with the runtime facts in `PiEnvironment`.
 */
export const envSet = pgTable(
  "environment",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("environment_user_name_idx").on(table.userId, table.name)],
);

/** Append-only. Values live only in `encrypted`; `entries` holds names and secret flags. */
export const envSetRevision = pgTable(
  "environment_revision",
  {
    id: uuid("id").primaryKey(),
    envSetId: uuid("environment_id")
      .notNull()
      .references(() => envSet.id, { onDelete: "cascade" }),
    /** 1-based, assigned under the env set's row lock; the highest is the latest. */
    number: integer("number").notNull(),
    encrypted: text("encrypted").notNull(),
    entries: jsonb("entries").$type<Array<{ name: string; secret: boolean }>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("environment_revision_number_idx").on(table.envSetId, table.number),
    check("environment_revision_number_check", sql`${table.number} >= 1`),
  ],
);
