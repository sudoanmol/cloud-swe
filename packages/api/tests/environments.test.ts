import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import Fastify, { type InjectOptions } from "fastify";
import { Client, Pool } from "pg";
import { createEnvSetStore } from "@cloud-swe/db/env-sets";
import * as schema from "@cloud-swe/db/schema/index";
import { createThreadStore } from "@cloud-swe/db/threads";
import { registerApiRoutes } from "../src/routes";

const baseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:password@localhost:5432/cloud-swe";

const database = `cloud_swe_env_api_${randomUUID().replaceAll("-", "").slice(0, 16)}`;

const testUrl = new URL(baseUrl);

testUrl.pathname = `/${database}`;

const admin = new Client({ connectionString: baseUrl });

const pool = new Pool({ connectionString: testUrl.toString() });

const db = drizzle(pool, { schema });

const origin = "https://web.example.test";

const secret = `sk-live-${randomUUID()}`;

const app = Fastify();

function as(user: string) {
  return { origin, "x-csrf-protection": "1", "x-user": user };
}

beforeAll(async () => {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  await migrate(db, {
    migrationsFolder: new URL("../../db/src/migrations", import.meta.url).pathname,
  });

  for (const id of ["alice", "mallory"])
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, $1, $2)`, [
      id,
      `${id}@example.test`,
    ]);

  registerApiRoutes(app, {
    auth: {
      getSession: async (request) => {
        const id = request.get("x-user");

        return id ? { user: { id }, session: {} } : null;
      },
      handler: async () => Response.json({}),
    },
    store: createThreadStore(db),
    environments: { store: createEnvSetStore(db, randomBytes(32).toString("hex")) },
    trustedOrigins: [origin],
    nodeEnv: "test",
    allowUnverifiedCompute: true,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
  await admin.end();
});

test("environment routes keep values write-only and owner-scoped", async () => {
  const bodies: string[] = [];

  const call = async (input: InjectOptions) => {
    const response = await app.inject(input);
    bodies.push(response.body);

    return response;
  };

  // Mutations follow the CSRF rules.
  expect(
    (
      await call({
        method: "POST",
        url: "/api/environments",
        headers: { "x-user": "alice" },
        payload: { name: "dev", dotenv: `API_KEY=${secret}` },
      })
    ).statusCode,
  ).toBe(403);

  const created = await call({
    method: "POST",
    url: "/api/environments",
    headers: as("alice"),
    payload: { name: "dev", dotenv: `API_KEY=${secret}\nPORT=3000\n` },
  });

  expect(created.statusCode).toBe(201);
  const id = created.json().id;
  expect(created.json().revision.entries).toEqual([
    { name: "API_KEY", secret: true },
    { name: "PORT", secret: false },
  ]);

  const invalid = await call({
    method: "PUT",
    url: `/api/environments/${id}`,
    headers: as("alice"),
    payload: { entries: [{ name: "TOKEN", secret: true, value: "short" }] },
  });

  expect(invalid.statusCode).toBe(400);
  expect(invalid.json().error.message).toContain("TOKEN");

  const updated = await call({
    method: "PUT",
    url: `/api/environments/${id}`,
    headers: as("alice"),
    payload: { entries: [{ name: "API_KEY", secret: true }] },
  });

  expect(updated.json().revision.number).toBe(2);

  const thread = await call({
    method: "POST",
    url: "/api/threads",
    headers: as("alice"),
    payload: { prompt: "go", clientMessageId: randomUUID(), environmentId: id },
  });

  expect(thread.statusCode).toBe(202);
  const threadId = thread.json().threadId;

  const view = await call({ url: `/api/threads/${threadId}`, headers: as("alice") });
  expect(view.json().environment).toMatchObject({ id, name: "dev", revisionNumber: 2 });

  expect(
    (
      await call({
        method: "PUT",
        url: `/api/threads/${threadId}/environment`,
        headers: as("mallory"),
        payload: { environmentId: null },
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await call({
        method: "POST",
        url: "/api/threads",
        headers: as("mallory"),
        payload: { prompt: "go", clientMessageId: randomUUID(), environmentId: id },
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (await call({ url: "/api/environments", headers: as("mallory") })).json().environments,
  ).toHaveLength(0);

  expect(
    (await call({ url: "/api/environments", headers: as("alice") })).json().environments,
  ).toHaveLength(1);
  expect(
    (
      await call({
        method: "PUT",
        url: `/api/threads/${threadId}/environment`,
        headers: as("alice"),
        payload: { environmentId: null },
      })
    ).statusCode,
  ).toBe(204);
  expect(
    (await call({ method: "DELETE", url: `/api/environments/${id}`, headers: as("alice") }))
      .statusCode,
  ).toBe(204);

  for (const body of bodies) expect(body).not.toContain(secret);
});
