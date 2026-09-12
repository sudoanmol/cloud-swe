import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { createDb } from "./index";
import { modelCredential } from "./schema/model-credentials";
import { modelProviderSchema } from "./model-selection";

export const modelEncryptionKeySchema = z.string().regex(/^[a-fA-F0-9]{64}$/);

const credentialSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("api_key"), key: z.string().trim().min(1).max(16384) }).strict(),
  z
    .object({
      type: z.literal("oauth"),
      access: z.string().min(1),
      refresh: z.string().min(1),
      expires: z.number().finite(),
      accountId: z.string().min(1),
    })
    .strict(),
]);

/** AES-GCM binds each ciphertext to its owner and provider to prevent row swapping. */
export function createModelCredentialStore(
  db: ReturnType<typeof createDb>,
  userId: string,
  encryptionKey: string,
): CredentialStore {
  const key = Buffer.from(modelEncryptionKeySchema.parse(encryptionKey), "hex");

  const where = (provider: string) =>
    and(eq(modelCredential.userId, userId), eq(modelCredential.provider, provider));

  const aad = (provider: string) => Buffer.from(JSON.stringify([userId, provider]));

  function decrypt(provider: string, encrypted: string) {
    const data = Buffer.from(encrypted, "base64");

    if (data[0] !== 1 || data.length < 30) throw new Error("Invalid encrypted model credential");
    const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(1, 13));
    decipher.setAAD(aad(provider));
    decipher.setAuthTag(data.subarray(13, 29));
    const plain = Buffer.concat([decipher.update(data.subarray(29)), decipher.final()]);

    return credentialSchema.parse(JSON.parse(plain.toString("utf8")));
  }

  const lock = (provider: string) =>
    sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["model-credential", userId, provider])}, 0))`;

  return {
    async read(provider) {
      if (!modelProviderSchema.safeParse(provider).success) return undefined;
      const [row] = await db.select().from(modelCredential).where(where(provider));

      return row ? decrypt(provider, row.encrypted) : undefined;
    },
    async list() {
      const rows = await db
        .select({ provider: modelCredential.provider })
        .from(modelCredential)
        .where(eq(modelCredential.userId, userId));

      return rows.map(({ provider }) => ({
        providerId: modelProviderSchema.parse(provider),
        type: provider === "openai-codex" ? "oauth" : "api_key",
      }));
    },
    async modify(provider, update, options) {
      modelProviderSchema.parse(provider);

      return db.transaction(async (tx) => {
        await tx.execute(lock(provider));
        options?.signal?.throwIfAborted();
        const [row] = await tx.select().from(modelCredential).where(where(provider));
        const current = row ? decrypt(provider, row.encrypted) : undefined;
        const next = await update(current);
        options?.signal?.throwIfAborted();

        if (!next) return current;
        const credential = credentialSchema.parse(next);

        if ((provider === "openai-codex") !== (credential.type === "oauth"))
          throw new Error("Credential type does not match provider");
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(aad(provider));

        const ciphertext = Buffer.concat([
          cipher.update(JSON.stringify(credential), "utf8"),
          cipher.final(),
        ]);

        const encrypted = Buffer.concat([
          Buffer.from([1]),
          nonce,
          cipher.getAuthTag(),
          ciphertext,
        ]).toString("base64");

        await tx
          .insert(modelCredential)
          .values({ userId, provider, encrypted })
          .onConflictDoUpdate({
            target: [modelCredential.userId, modelCredential.provider],
            set: { encrypted, updatedAt: new Date() },
          });

        return credential;
      });
    },
    async delete(provider, options) {
      modelProviderSchema.parse(provider);
      await db.transaction(async (tx) => {
        await tx.execute(lock(provider));
        options?.signal?.throwIfAborted();
        await tx.delete(modelCredential).where(where(provider));
      });
    },
  };
}
