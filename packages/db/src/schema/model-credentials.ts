import { pgTable, text, primaryKey, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth";

export const modelCredential = pgTable(
  "model_credential",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    encrypted: text("encrypted").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.provider] })],
);
