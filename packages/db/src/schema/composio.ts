import { pgTable, text } from "drizzle-orm/pg-core";
import { user } from "./auth";

/** Session IDs only. MCP URLs and credential headers stay in server memory. */
export const composioSession = pgTable("composio_session", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull().unique(),
});
