import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { parse as parseDotenv } from "dotenv";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { createDb } from "./index";
import { envSet, envSetRevision } from "./schema/environments";
import { run, thread } from "./schema/threads";
import { ThreadStoreError } from "./thread-contracts";
import { ownedThread, postgresField } from "./threads/shared";

export const envSetEncryptionKeySchema = z.string().regex(/^[a-fA-F0-9]{64}$/);

/** Shorter values cannot be redacted without mangling ordinary output. */
export const SECRET_MIN_LENGTH = 8;

/** Well under Linux's per-process environment limit. */
const REVISION_MAX_BYTES = 65_536;

const ENTRY_MAX_COUNT = 200;

const reservedNames = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "GIT_CONFIG_GLOBAL",
  "PREVIEW_URL_TEMPLATE",
]);

export const envNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use letters, digits, and underscores")
  .max(128)
  .refine(
    (name) =>
      !reservedNames.has(name) && !name.startsWith("__VITE_") && !name.startsWith("CLOUD_SWE_"),
    "This name is reserved",
  );

export const envSetNameSchema = z.string().trim().min(1).max(80);

export type EnvEntry = { name: string; secret: boolean };

/** Entries plus values, decrypted for delivery, redaction, and the Git scan. Never logged. */
export type EnvValues = { entries: EnvEntry[]; values: Record<string, string> };

export type EnvSetSummary = {
  id: string;
  name: string;
  createdAt: Date;
  revision: { id: string; number: number; createdAt: Date; entries: EnvEntry[] };
};

const valuesSchema = z.record(z.string(), z.string());

const entriesSchema = z.array(z.object({ name: z.string(), secret: z.boolean() }).strict());

function invalid(message: string): ThreadStoreError {
  return new ThreadStoreError("INVALID_ENVIRONMENT", message, 400);
}

/**
 * Validate a full revision. Errors name the variable, never its value.
 */
export function validateEnvEntries(entries: Array<EnvEntry & { value: string }>): EnvValues {
  if (entries.length > ENTRY_MAX_COUNT) throw invalid(`Use at most ${ENTRY_MAX_COUNT} variables`);
  const values: Record<string, string> = {};
  let bytes = 0;

  for (const entry of entries) {
    const name = envNameSchema.safeParse(entry.name);

    if (!name.success)
      throw invalid(`${entry.name.slice(0, 128)}: ${name.error.issues[0]?.message}`);

    if (Object.hasOwn(values, entry.name)) throw invalid(`${entry.name} is listed twice`);

    if (entry.value.includes("\0")) throw invalid(`${entry.name} contains a NUL character`);

    if (entry.secret && entry.value.length < SECRET_MIN_LENGTH)
      throw invalid(
        `${entry.name} is shorter than ${SECRET_MIN_LENGTH} characters; store it as a plain variable`,
      );
    values[entry.name] = entry.value;
    bytes += Buffer.byteLength(entry.name) + Buffer.byteLength(entry.value) + 2;
  }

  if (bytes > REVISION_MAX_BYTES) throw invalid("Variables exceed 64 KiB");

  return { entries: entries.map(({ name, secret }) => ({ name, secret })), values };
}

/**
 * Parse `.env` text without command evaluation or variable expansion. Values
 * long enough to redact are secret by default.
 */
export function parseEnvText(text: string): Array<EnvEntry & { value: string }> {
  const names = text
    .split(/\r?\n/)
    .map((line) => /^\s*(?:export\s+)?([\w.-]+)\s*[=:]/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);

  const duplicate = names.find((name, index) => names.indexOf(name) !== index);

  if (duplicate) throw invalid(`${duplicate} is listed twice`);

  return Object.entries(parseDotenv(text)).map(([name, value]) => ({
    name,
    value,
    secret: value.length >= SECRET_MIN_LENGTH,
  }));
}

/** AES-GCM binds each revision's ciphertext to its owner and identity to prevent row swapping. */
function cipher(encryptionKey: string) {
  const key = Buffer.from(envSetEncryptionKeySchema.parse(encryptionKey), "hex");

  const aad = (owner: { userId: string; envSetId: string; revisionId: string }) =>
    Buffer.from(JSON.stringify(["environment", owner.userId, owner.envSetId, owner.revisionId]));

  return {
    encrypt(owner: Parameters<typeof aad>[0], values: Record<string, string>): string {
      const nonce = randomBytes(12);
      const encryptor = createCipheriv("aes-256-gcm", key, nonce);
      encryptor.setAAD(aad(owner));

      const ciphertext = Buffer.concat([
        encryptor.update(JSON.stringify(values), "utf8"),
        encryptor.final(),
      ]);

      return Buffer.concat([Buffer.from([1]), nonce, encryptor.getAuthTag(), ciphertext]).toString(
        "base64",
      );
    },
    decrypt(owner: Parameters<typeof aad>[0], encrypted: string): Record<string, string> {
      const data = Buffer.from(encrypted, "base64");

      if (data[0] !== 1 || data.length < 30) throw new Error("Invalid encrypted environment");
      const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(1, 13));
      decipher.setAAD(aad(owner));
      decipher.setAuthTag(data.subarray(13, 29));
      const plain = Buffer.concat([decipher.update(data.subarray(29)), decipher.final()]);

      return valuesSchema.parse(JSON.parse(plain.toString("utf8")));
    },
  };
}

const notFound = () => new ThreadStoreError("ENVIRONMENT_NOT_FOUND", "Environment not found", 404);

export function createEnvSetStore(db: ReturnType<typeof createDb>, encryptionKey: string) {
  const { encrypt, decrypt } = cipher(encryptionKey);

  async function summaries(userId: string, id?: string): Promise<EnvSetSummary[]> {
    const rows = await db
      .selectDistinctOn([envSet.id], {
        id: envSet.id,
        name: envSet.name,
        createdAt: envSet.createdAt,
        revisionId: envSetRevision.id,
        number: envSetRevision.number,
        revisionCreatedAt: envSetRevision.createdAt,
        entries: envSetRevision.entries,
      })
      .from(envSet)
      .innerJoin(envSetRevision, eq(envSetRevision.envSetId, envSet.id))
      .where(and(eq(envSet.userId, userId), id ? eq(envSet.id, id) : undefined))
      .orderBy(asc(envSet.id), desc(envSetRevision.number));

    return rows
      .map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.createdAt,
        revision: {
          id: row.revisionId,
          number: row.number,
          createdAt: row.revisionCreatedAt,
          entries: entriesSchema.parse(row.entries),
        },
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async function one(userId: string, id: string): Promise<EnvSetSummary> {
    const [summary] = await summaries(userId, id);

    if (!summary) throw notFound();

    return summary;
  }

  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

  async function insertRevision(
    tx: Tx,
    owner: { userId: string; envSetId: string },
    number: number,
    validated: EnvValues,
  ) {
    const revisionId = randomUUID();

    await tx.insert(envSetRevision).values({
      id: revisionId,
      envSetId: owner.envSetId,
      number,
      entries: validated.entries,
      encrypted: encrypt({ ...owner, revisionId }, validated.values),
    });
  }

  async function renamed<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (postgresField(error, "constraint") === "environment_user_name_idx")
        throw new ThreadStoreError(
          "ENVIRONMENT_NAME_TAKEN",
          "An environment with this name exists",
          409,
        );
      throw error;
    }
  }

  return {
    list: (userId: string) => summaries(userId),

    async create(input: {
      userId: string;
      name: string;
      entries: Array<EnvEntry & { value: string }>;
    }): Promise<EnvSetSummary> {
      const validated = validateEnvEntries(input.entries);

      const id = await renamed(() =>
        db.transaction(async (tx) => {
          const [created] = await tx
            .insert(envSet)
            .values({ userId: input.userId, name: input.name })
            .returning({ id: envSet.id });

          if (!created) throw new Error("Environment insert returned no row");
          await insertRevision(tx, { userId: input.userId, envSetId: created.id }, 1, validated);

          return created.id;
        }),
      );

      return one(input.userId, id);
    },

    /** Append a revision. An omitted value keeps the latest revision's value for `previousName ?? name`. */
    async update(input: {
      userId: string;
      id: string;
      name?: string;
      entries: Array<EnvEntry & { value?: string; previousName?: string }>;
    }): Promise<EnvSetSummary> {
      await renamed(() =>
        db.transaction(async (tx) => {
          const [owned] = await tx
            .select({ id: envSet.id })
            .from(envSet)
            .where(and(eq(envSet.id, input.id), eq(envSet.userId, input.userId)))
            .for("update");

          if (!owned) throw notFound();

          const [latest] = await tx
            .select()
            .from(envSetRevision)
            .where(eq(envSetRevision.envSetId, input.id))
            .orderBy(desc(envSetRevision.number))
            .limit(1);

          if (!latest) throw new Error("Environment has no revision");

          const previous = decrypt(
            { userId: input.userId, envSetId: input.id, revisionId: latest.id },
            latest.encrypted,
          );

          const validated = validateEnvEntries(
            input.entries.map((entry) => {
              const value = entry.value ?? previous[entry.previousName ?? entry.name];

              if (value === undefined) throw invalid(`${entry.name} needs a value`);

              return { name: entry.name, secret: entry.secret, value };
            }),
          );

          if (input.name !== undefined)
            await tx.update(envSet).set({ name: input.name }).where(eq(envSet.id, input.id));
          await insertRevision(
            tx,
            { userId: input.userId, envSetId: input.id },
            latest.number + 1,
            validated,
          );
        }),
      );

      return one(input.userId, input.id);
    },

    /** Cascades to every revision, purging the ciphertext; pinned threads and runs fall back to none. */
    async remove(input: { userId: string; id: string }): Promise<void> {
      const deleted = await db
        .delete(envSet)
        .where(and(eq(envSet.id, input.id), eq(envSet.userId, input.userId)))
        .returning({ id: envSet.id });

      if (!deleted[0]) throw notFound();
    },

    /** Pin the thread to the env set's latest revision, or detach it. The next run uses it. */
    async setThreadEnvSet(input: {
      userId: string;
      threadId: string;
      envSetId: string | null;
    }): Promise<void> {
      await db.transaction(async (tx) => {
        const revisionId = input.envSetId
          ? await latestOwnedRevisionId(tx, input.userId, input.envSetId)
          : null;

        const updated = await tx
          .update(thread)
          .set({ envSetRevisionId: revisionId })
          .where(ownedThread(input.threadId, input.userId))
          .returning({ id: thread.id });

        if (!updated[0]) throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);
      });
    },

    /** The values a run was admitted with, or null when it has none or it was deleted. */
    async readRunValues(runId: string): Promise<EnvValues | null> {
      const [row] = await db
        .select({
          runUserId: run.userId,
          userId: envSet.userId,
          envSetId: envSet.id,
          revisionId: envSetRevision.id,
          encrypted: envSetRevision.encrypted,
          entries: envSetRevision.entries,
        })
        .from(run)
        .innerJoin(envSetRevision, eq(envSetRevision.id, run.envSetRevisionId))
        .innerJoin(envSet, eq(envSet.id, envSetRevision.envSetId))
        .where(eq(run.id, runId))
        .limit(1);

      if (!row) return null;

      if (row.userId !== row.runUserId) throw new Error("Environment owner does not match the run");

      return {
        entries: entriesSchema.parse(row.entries),
        values: decrypt(row, row.encrypted),
      };
    },
  };
}

export type EnvSetStore = ReturnType<typeof createEnvSetStore>;

/** The latest revision of an env set the user owns. Admission and attach both resolve through it. */
export async function latestOwnedRevisionId(
  tx: Pick<ReturnType<typeof createDb>, "select">,
  userId: string,
  envSetId: string,
): Promise<string> {
  const [latest] = await tx
    .select({ id: envSetRevision.id })
    .from(envSetRevision)
    .innerJoin(envSet, eq(envSet.id, envSetRevision.envSetId))
    .where(and(eq(envSet.id, envSetId), eq(envSet.userId, userId)))
    .orderBy(desc(envSetRevision.number))
    .limit(1)
    .for("share", { of: envSet });

  if (!latest) throw notFound();

  return latest.id;
}
