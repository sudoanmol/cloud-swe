import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import { publicFailureMessage } from "../public-failure";
import { outbox } from "../schema/threads";
import { type ThreadStore } from "../thread-contracts";

import { type Db } from "./shared";

export function createOutboxStore(
  db: Db,
): Pick<ThreadStore, "listPendingOutbox" | "markDelivered" | "recordFailure"> {
  return {
    async listPendingOutbox(limit = 100) {
      return db
        .select()
        .from(outbox)
        .where(and(isNull(outbox.deliveredAt), lt(outbox.availableAt, new Date())))
        .orderBy(asc(outbox.createdAt))
        .limit(limit);
    },

    async markDelivered(id) {
      await db.update(outbox).set({ deliveredAt: new Date() }).where(eq(outbox.id, id));
    },

    async recordFailure(id, error, retryAt = new Date(Date.now() + 1000)) {
      await db
        .update(outbox)
        .set({
          attempts: sql`${outbox.attempts} + 1`,
          lastError: publicFailureMessage(error),
          availableAt: retryAt,
        })
        .where(eq(outbox.id, id));
    },
  };
}
