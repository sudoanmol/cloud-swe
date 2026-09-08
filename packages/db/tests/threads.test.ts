import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as schema from "../src/schema";
import { createThreadStore } from "../src/threads";
import { ThreadStoreError } from "../src/thread-contracts";

const baseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:password@localhost:5432/cloud-swe";
const database = `cloud_swe_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const testUrl = new URL(baseUrl);
testUrl.pathname = `/${database}`;
let admin: Client;
let pool: Pool;
let store: ReturnType<typeof createThreadStore>;
const userId = `test-user-${randomUUID()}`;
let currentUserId = userId;

beforeAll(async () => {
  admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  pool = new Pool({ connectionString: testUrl.toString() });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: new URL("../src/migrations", import.meta.url).pathname });
  await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`, [
    userId,
    "Test",
    `${userId}@example.test`,
  ]);
  store = createThreadStore(db);
});

beforeEach(async () => {
  currentUserId = `test-user-${randomUUID()}`;
  await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`, [
    currentUserId,
    "Test",
    `${currentUserId}@example.test`,
  ]);
});

afterAll(async () => {
  await pool?.end();
  await admin?.query(`DROP DATABASE IF EXISTS "${database}"`);
  await admin?.end();
});

describe("ThreadStore PostgreSQL contract", () => {
  test("retries the original run after completion and rejects intent conflicts", async () => {
    const first = await store.submitThread({
      userId: currentUserId,
      prompt: "first",
      clientMessageId: "retry-1",
    });
    await store.completeRun(first.runId, "done");
    const followup = await store.submitMessage({
      userId: currentUserId,
      threadId: first.threadId,
      prompt: "second",
      clientMessageId: "followup-1",
    });
    expect(
      await store.submitThread({
        userId: currentUserId,
        prompt: "first",
        clientMessageId: "retry-1",
      }),
    ).toEqual(first);
    await expect(
      store.submitThread({
        userId: currentUserId,
        prompt: "different",
        clientMessageId: "retry-1",
      }),
    ).rejects.toBeInstanceOf(ThreadStoreError);
    await expect(
      store.submitThread({
        userId: currentUserId,
        prompt: "second",
        clientMessageId: "followup-1",
      }),
    ).rejects.toBeInstanceOf(ThreadStoreError);
    expect(followup.threadId).toBe(first.threadId);
    await store.cancelRun(followup.runId);
  });

  test("serializes concurrent idempotent submissions", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        store.submitThread({
          userId: currentUserId,
          prompt: "parallel",
          clientMessageId: "parallel-1",
        }),
      ),
    );
    expect(new Set(results.map((result) => `${result.threadId}:${result.runId}`)).size).toBe(1);
    await store.cancelRun(results[0]!.runId);
  });

  test("deduplicates concurrent event appends", async () => {
    const submitted = await store.submitThread({
      userId: currentUserId,
      prompt: "events",
      clientMessageId: "events-1",
      maxActiveRuns: 100,
    });
    const events = await Promise.all(
      Array.from({ length: 10 }, () =>
        store.appendRunEvent({
          runId: submitted.runId,
          type: "token",
          payload: { value: "x" },
          dedupeKey: "token-1",
        }),
      ),
    );
    expect(new Set(events.map((event) => event.sequence)).size).toBe(1);
    await store.cancelRun(submitted.runId);
  });

  test("prevents active user duplicates and terminal resurrection", async () => {
    const first = await store.submitThread({
      userId: currentUserId,
      prompt: "active",
      clientMessageId: "active-1",
    });
    await expect(
      store.submitThread({ userId: currentUserId, prompt: "active2", clientMessageId: "active-2" }),
    ).rejects.toBeInstanceOf(ThreadStoreError);
    await store.cancelRun(first.runId);
    await store.startRun(first.runId);
    await store.saveCheckpoint({ runId: first.runId, step: 1, content: { ignored: true } });
    expect(await store.loadCheckpoint({ runId: first.runId, step: 1 })).toBeNull();
    await expect(
      store.appendRunEvent({ runId: first.runId, type: "late", payload: {}, dedupeKey: "late" }),
    ).rejects.toBeInstanceOf(ThreadStoreError);
  });

  test("updates Pi checkpoints and loads the latest session for a thread", async () => {
    const first = await store.submitThread({
      userId: currentUserId,
      prompt: "checkpoint one",
      clientMessageId: "checkpoint-1",
      maxActiveRuns: 100,
    });
    await store.startRun(first.runId);
    await store.saveCheckpoint({ runId: first.runId, step: 1, content: { version: 1 } });
    await store.saveCheckpoint({ runId: first.runId, step: 1, content: { version: 2 } });
    expect((await store.loadCheckpoint({ runId: first.runId, step: 1 }))?.content).toEqual({
      version: 2,
    });
    await store.completeRun(first.runId, "done");

    const second = await store.submitMessage({
      userId: currentUserId,
      threadId: first.threadId,
      prompt: "checkpoint two",
      clientMessageId: "checkpoint-2",
      maxActiveRuns: 100,
    });
    await store.startRun(second.runId);
    await store.saveCheckpoint({ runId: second.runId, step: 1, content: { version: 3 } });
    expect(
      (await store.loadLatestCheckpoint({ threadId: first.threadId, step: 1 }))?.content,
    ).toEqual({ version: 3 });
    await store.cancelRun(second.runId);
  });

  test("returns an ordered cursor from a consistent snapshot", async () => {
    const submitted = await store.submitThread({
      userId: currentUserId,
      prompt: "cursor",
      clientMessageId: "cursor-1",
      maxActiveRuns: 100,
    });
    await store.appendRunEvent({
      runId: submitted.runId,
      type: "one",
      payload: {},
      dedupeKey: "one",
    });
    const view = await store.getThread({ userId: currentUserId, threadId: submitted.threadId });
    const events = await store.listEvents({ userId: currentUserId, threadId: submitted.threadId });
    expect(view.latestEventId).toBe(String(events.at(-1)?.sequence));
    expect(events.map((event) => event.sequence)).toEqual(
      [...events].map((event) => event.sequence).sort((a, b) => a - b),
    );
  });

  test("records each workspace state transition while deduplicating no-ops", async () => {
    const submitted = await store.submitThread({
      userId: currentUserId,
      prompt: "workspace",
      clientMessageId: "workspace-1",
      maxActiveRuns: 100,
    });
    await store.updateWorkspace({ threadId: submitted.threadId, state: "provisioning" });
    await store.updateWorkspace({ threadId: submitted.threadId, state: "running" });
    await store.updateWorkspace({ threadId: submitted.threadId, state: "paused" });
    await store.updateWorkspace({ threadId: submitted.threadId, state: "running" });
    await store.updateWorkspace({ threadId: submitted.threadId, state: "running" });
    const events = await store.listEvents({ userId: currentUserId, threadId: submitted.threadId });
    expect(
      events.filter((event) => event.type.startsWith("workspace.")).map((event) => event.type),
    ).toEqual([
      "workspace.provisioning",
      "workspace.running",
      "workspace.paused",
      "workspace.running",
    ]);
    await store.cancelRun(submitted.runId);
  });
});
