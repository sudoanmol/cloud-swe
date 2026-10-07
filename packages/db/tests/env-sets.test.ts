import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import { createEnvSetStore, parseEnvText } from "../src/env-sets";
import * as schema from "../src/schema";
import { createThreadStore } from "../src/threads";

const baseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:password@localhost:5432/cloud-swe";

const database = `cloud_swe_env_${randomUUID().replaceAll("-", "").slice(0, 16)}`;

const testUrl = new URL(baseUrl);

testUrl.pathname = `/${database}`;

const admin = new Client({ connectionString: baseUrl });

const pool = new Pool({ connectionString: testUrl.toString() });

const db = drizzle(pool, { schema });

const threads = createThreadStore(db);

const envSets = createEnvSetStore(db, randomBytes(32).toString("hex"));

const secret = `sk-test-${randomUUID()}`;

async function user(): Promise<string> {
  const id = `env-user-${randomUUID()}`;
  await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Env', $2)`, [
    id,
    `${id}@example.test`,
  ]);

  return id;
}

async function startThread(userId: string, envSetId?: string) {
  const submitted = await threads.submitThread({
    userId,
    prompt: "go",
    clientMessageId: randomUUID(),
    maxActiveRuns: 100,
    envSetId,
  });

  return submitted;
}

async function finish(runId: string) {
  await pool.query(`UPDATE run SET status = 'completed' WHERE id = $1`, [runId]);
}

beforeAll(async () => {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  await migrate(db, { migrationsFolder: new URL("../src/migrations", import.meta.url).pathname });
});

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
  await admin.end();
});

test("values round-trip, stay out of listings, and a swapped row fails to decrypt", async () => {
  const userId = await user();

  const first = await envSets.create({
    userId,
    name: "dev",
    entries: [
      { name: "API_KEY", secret: true, value: secret },
      { name: "PORT", secret: false, value: "3000" },
    ],
  });

  const other = await envSets.create({
    userId,
    name: "other",
    entries: [{ name: "API_KEY", secret: true, value: "another-value" }],
  });

  expect(first.revision.entries).toEqual([
    { name: "API_KEY", secret: true },
    { name: "PORT", secret: false },
  ]);
  expect(JSON.stringify(await envSets.list(userId))).not.toContain(secret);

  const { runId } = await startThread(userId, first.id);
  expect(await envSets.readRunValues(runId)).toEqual({
    entries: first.revision.entries,
    values: { API_KEY: secret, PORT: "3000" },
  });

  // Copy another revision's ciphertext into this one: AAD binds the row identity.
  const [donor] = await db
    .select({ encrypted: schema.envSetRevision.encrypted })
    .from(schema.envSetRevision)
    .where(eq(schema.envSetRevision.id, other.revision.id));

  await db
    .update(schema.envSetRevision)
    .set({ encrypted: donor!.encrypted })
    .where(eq(schema.envSetRevision.id, first.revision.id));
  await expect(envSets.readRunValues(runId)).rejects.toThrow();
});

test("another user's environment cannot be referenced", async () => {
  const owner = await user();
  const intruder = await user();

  const owned = await envSets.create({
    userId: owner,
    name: "private",
    entries: [{ name: "TOKEN", secret: true, value: secret }],
  });

  await expect(startThread(intruder, owned.id)).rejects.toMatchObject({
    code: "ENVIRONMENT_NOT_FOUND",
  });

  const { threadId } = await startThread(intruder);
  await expect(
    envSets.setThreadEnvSet({ userId: intruder, threadId, envSetId: owned.id }),
  ).rejects.toMatchObject({ code: "ENVIRONMENT_NOT_FOUND" });
  await expect(
    envSets.update({ userId: intruder, id: owned.id, entries: [] }),
  ).rejects.toMatchObject({ code: "ENVIRONMENT_NOT_FOUND" });
  await expect(envSets.remove({ userId: intruder, id: owned.id })).rejects.toMatchObject({
    code: "ENVIRONMENT_NOT_FOUND",
  });
});

test("threads stay pinned, and a switch applies to the next run only", async () => {
  const userId = await user();

  const created = await envSets.create({
    userId,
    name: "app",
    entries: [{ name: "KEY", secret: true, value: "first-value" }],
  });

  const { threadId, runId } = await startThread(userId, created.id);

  // An omitted value keeps the previous one, including across a rename.
  const edited = await envSets.update({
    userId,
    id: created.id,
    entries: [
      { name: "RENAMED", previousName: "KEY", secret: true },
      { name: "EXTRA", secret: false, value: "x" },
    ],
  });

  expect(edited.revision.number).toBe(2);

  expect((await envSets.readRunValues(runId))?.values).toEqual({ KEY: "first-value" });
  expect((await threads.getThread({ userId, threadId })).environment).toMatchObject({
    id: created.id,
    revisionNumber: 1,
    latestRevisionNumber: 2,
  });

  // "Update to latest" while the run is active leaves that run on revision 1.
  await envSets.setThreadEnvSet({ userId, threadId, envSetId: created.id });
  expect((await envSets.readRunValues(runId))?.values).toEqual({ KEY: "first-value" });

  await finish(runId);

  const followup = await threads.submitMessage({
    userId,
    threadId,
    prompt: "again",
    clientMessageId: randomUUID(),
    maxActiveRuns: 100,
  });

  expect((await envSets.readRunValues(followup.runId))?.values).toEqual({
    RENAMED: "first-value",
    EXTRA: "x",
  });
});

test("deleting an environment purges its ciphertext and detaches threads", async () => {
  const userId = await user();

  const created = await envSets.create({
    userId,
    name: "gone",
    entries: [{ name: "KEY", secret: true, value: secret }],
  });

  const { threadId, runId } = await startThread(userId, created.id);
  await envSets.remove({ userId, id: created.id });

  const remaining = await pool.query(
    `SELECT count(*)::int AS count FROM environment_revision WHERE environment_id = $1`,
    [created.id],
  );

  expect(remaining.rows[0].count).toBe(0);
  expect(await envSets.readRunValues(runId)).toBeNull();
  expect((await threads.getThread({ userId, threadId })).environment).toBeNull();
});

test("validation names the variable and never echoes the value", async () => {
  const userId = await user();

  const attempt = (entries: Array<{ name: string; secret: boolean; value: string }>) =>
    envSets.create({ userId, name: randomUUID(), entries });

  await expect(attempt([{ name: "PATH", secret: false, value: "/bin" }])).rejects.toThrow("PATH");
  await expect(attempt([{ name: "CLOUD_SWE_X", secret: false, value: "1" }])).rejects.toThrow(
    "reserved",
  );
  await expect(attempt([{ name: "1BAD", secret: false, value: "1" }])).rejects.toThrow("1BAD");
  await expect(attempt([{ name: "SHORT", secret: true, value: "abc" }])).rejects.toThrow(
    "SHORT is shorter than 8 characters",
  );
  await expect(
    attempt([{ name: "BIG", secret: false, value: "x".repeat(70_000) }]),
  ).rejects.toThrow("64 KiB");

  expect(() => parseEnvText("A=1\nA=2\n")).toThrow("A is listed twice");
  expect(parseEnvText(`export TOKEN="${secret}"\nPORT=3000\nX=$(whoami)\n`)).toEqual([
    { name: "TOKEN", value: secret, secret: true },
    { name: "PORT", value: "3000", secret: false },
    { name: "X", value: "$(whoami)", secret: true },
  ]);
});
