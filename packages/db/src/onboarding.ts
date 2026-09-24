import { eq } from "drizzle-orm";

import { user } from "./schema/auth";
import { modelCredential } from "./schema/model-credentials";
import { ThreadStoreError } from "./thread-contracts";
import type { Db } from "./threads/shared";

/**
 * Server-owned onboarding state.
 *
 * Completion and credential deletion both serialize on the user row, so a
 * concurrent last-provider deletion cannot leave completion true after leaving
 * the account without a provider. Completion never acquires the per-provider
 * advisory lock; deletion acquires it before the user row.
 */
export function createOnboardingStore(db: Db) {
  return {
    async readState(userId: string): Promise<{ completed: boolean }> {
      const [row] = await db
        .select({ onboardingCompleted: user.onboardingCompleted })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1);

      if (!row) throw new ThreadStoreError("UNAUTHORIZED", "Authentication required", 401);

      return { completed: row.onboardingCompleted };
    },

    /**
     * Idempotent completion. Takes no client-controlled flag: it rechecks the
     * provider condition inside the transaction and persists completion.
     */
    async complete(userId: string): Promise<{ completed: true }> {
      return db.transaction(async (tx) => {
        const [owner] = await tx
          .select({ id: user.id, onboardingCompleted: user.onboardingCompleted })
          .from(user)
          .where(eq(user.id, userId))
          .for("update")
          .limit(1);

        if (!owner) throw new ThreadStoreError("UNAUTHORIZED", "Authentication required", 401);

        const [credential] = await tx
          .select({ provider: modelCredential.provider })
          .from(modelCredential)
          .where(eq(modelCredential.userId, userId))
          .limit(1);

        if (!credential)
          throw new ThreadStoreError(
            "PROVIDER_REQUIRED",
            "Connect a model provider before finishing setup",
            409,
          );

        if (!owner.onboardingCompleted)
          await tx
            .update(user)
            .set({ onboardingCompleted: true, updatedAt: new Date() })
            .where(eq(user.id, userId));

        return { completed: true };
      });
    },

    /** A confirmed loss of GitHub eligibility or of every provider clears completion. */
    async clear(userId: string): Promise<void> {
      await db
        .update(user)
        .set({ onboardingCompleted: false, updatedAt: new Date() })
        .where(eq(user.id, userId));
    },
  };
}

export type OnboardingStore = ReturnType<typeof createOnboardingStore>;
