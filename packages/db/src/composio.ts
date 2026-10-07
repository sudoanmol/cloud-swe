import { Composio } from "@composio/core";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { composioSession } from "./schema/composio";
import { user } from "./schema/auth";
import { ThreadStoreError } from "./thread-contracts";
import type { Db } from "./threads/shared";

export const composioMcpSchema = z.object({
  url: z.url(),
  headers: z.record(z.string(), z.string()),
});

export type ComposioMcp = z.infer<typeof composioMcpSchema>;

export const disabledComposioToolkits = ["github", "composio_search"];

/** SDK errors can contain request headers. Never propagate their causes or text. */
export function composioUnavailable(): ThreadStoreError {
  return new ThreadStoreError("TOOLS_UNAVAILABLE", "Tools are temporarily unavailable", 503);
}

export function createComposioSessions(db: Db, apiKey: string) {
  const composio = new Composio({
    apiKey,
    logLevel: "silent",
    allowTracking: false,
    disableVersionCheck: true,
  });

  async function readId(userId: string) {
    const [row] = await db.select().from(composioSession).where(eq(composioSession.userId, userId));

    return row?.sessionId;
  }

  return {
    /** API only: serialize lazy creation across requests and API processes. */
    async ensure(userId: string): Promise<void> {
      try {
        if (await readId(userId)) return;
        await db.transaction(async (tx) => {
          const [owner] = await tx
            .select({ id: user.id })
            .from(user)
            .where(eq(user.id, userId))
            .for("update");

          if (!owner) throw composioUnavailable();

          const [existing] = await tx
            .select()
            .from(composioSession)
            .where(eq(composioSession.userId, userId));

          if (existing) return;

          const session = await composio.create(userId, {
            mcp: true,
            toolkits: { disable: disabledComposioToolkits },
            instant: false,
            sandbox: { enable: false },
          });

          await tx
            .insert(composioSession)
            .values({ userId, sessionId: z.string().min(1).parse(session.sessionId) });
        });
      } catch {
        throw composioUnavailable();
      }
    },
    /** Runner only resumes the API-owned session, never creates a new one. */
    async resolve(userId: string) {
      try {
        const id = await readId(userId);

        if (!id) throw composioUnavailable();

        return await composio.use(id, { mcp: true });
      } catch {
        throw composioUnavailable();
      }
    },
  };
}

export type ComposioSessions = ReturnType<typeof createComposioSessions>;
