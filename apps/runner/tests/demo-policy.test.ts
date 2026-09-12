import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as schema from "@cloud-swe/db/schema/index";
import { createThreadStore } from "@cloud-swe/db/threads";
import { createDemoCompute, allocateRuntimeMonths } from "../src/demo-compute.js";
import { publicFailureForCode } from "@cloud-swe/db/public-failure";

const database = `demo_policy_${randomUUID().replaceAll("-", "")}`;

const url = new URL(
  process.env.DATABASE_URL ?? "postgresql://postgres:password@localhost:5432/cloud-swe",
);

const admin = new Client({ connectionString: url.toString() });

url.pathname = `/${database}`;

const pool = new Pool({ connectionString: url.toString() });

const db = drizzle(pool, { schema });

const store = createThreadStore(db, { primaryGithubAccountId: "123456" });

const compute = createDemoCompute(pool, 2400);

let userId = "";

beforeAll(async () => {
  await admin.connect();
  await admin.query(`create database "${database}"`);
  await migrate(db, {
    migrationsFolder: new URL("../../../packages/db/src/migrations", import.meta.url).pathname,
  });
});

beforeEach(async () => {
  await pool.query('truncate "user", demo_compute_usage cascade');
  userId = await user();
});

afterAll(async () => {
  await pool.end();
  await admin.query(`drop database "${database}"`);
  await admin.end();
});

async function user() {
  const id = randomUUID();
  await pool.query('insert into "user"(id,name,email) values ($1,$1,$2)', [
    id,
    `${id}@test.invalid`,
  ]);

  return id;
}

async function owner(id: string) {
  await pool.query(
    "insert into account(id,issuer,account_id,provider_id,user_id,updated_at) values ($1,$2,$3,$4,$5,now())",
    [randomUUID(), "github", "123456", "github", id],
  );
}

async function submit(id = userId) {
  return store.submitThread({
    userId: id,
    clientMessageId: randomUUID(),
    prompt: "test",
    maxActiveRuns: 10,
  });
}

async function complete(runId: string) {
  const claim = await store.claimExecutionOwnership({
    runId,
    attemptId: randomUUID(),
    generation: 1,
  });

  await store.completeRun(runId, "done", claim.token);
}

async function begin(runId: string) {
  const claim = await store.claimExecutionOwnership({
    runId,
    attemptId: randomUUID(),
    generation: 1,
  });

  return store.beginAgentExecution(runId, claim.token);
}

async function reserve(id = userId) {
  const submitted = await submit(id);

  const workspace = await store.updateWorkspace({
    threadId: submitted.threadId,
    provider: "freestyle",
    state: "provisioning",
  });

  const reservation = await compute.reserve({
    workspaceId: workspace.id,
    runId: submitted.runId,
    seconds: 1200,
    baselineSeconds: 10,
    providerId: "vm-test",
  });

  return { ...submitted, workspace, reservation };
}

test("numeric linked GitHub identity permits five owner tasks while unset configuration grants none", async () => {
  await owner(userId);
  expect(await store.isOwner(userId)).toBe(true);
  expect(await createThreadStore(db).isOwner(userId)).toBe(false);
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => submit()));
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  const other = await user();
  expect(await submit(other)).toHaveProperty("runId");
});

test("each visitor has independent concurrency and three transactional turns including follow-ups", async () => {
  const first = await submit();
  await expect(submit()).rejects.toMatchObject({ code: "USER_BUSY" });
  await submit(await user());
  await complete(first.runId);

  for (let turn = 0; turn < 2; turn++) {
    const next = await store.submitMessage({
      userId,
      threadId: first.threadId,
      clientMessageId: randomUUID(),
      prompt: "again",
      maxActiveRuns: 10,
    });

    await complete(next.runId);
  }

  await expect(submit()).rejects.toMatchObject({ code: "DEMO_TURN_LIMIT" });
});

test("idempotency does not reserve another turn, infrastructure refunds, execution cancellation consumes", async () => {
  const input = { userId, clientMessageId: "same", prompt: "test", maxActiveRuns: 10 };
  const [first, retry] = await Promise.all([store.submitThread(input), store.submitThread(input)]);
  expect(retry).toEqual(first);
  await store.failRun(first.runId, publicFailureForCode("PROVIDER_UNAVAILABLE").message);
  expect(
    (await pool.query("select state from demo_turn where run_id = $1", [first.runId])).rows[0],
  ).toEqual({ state: "released" });
  const events = await store.listEvents({ threadId: first.threadId });
  expect(events.at(-1)?.payload).toMatchObject({
    turnRestored: true,
    code: "PROVIDER_UNAVAILABLE",
  });
  const next = await submit();
  const started = await begin(next.runId);
  expect(await begin(next.runId)).toEqual(started);
  await store.cancelRun(next.runId);
  expect(
    (await pool.query("select state from demo_turn where run_id = $1", [next.runId])).rows[0],
  ).toEqual({ state: "consumed" });
  const before = await submit();
  await store.cancelRun(before.runId);
  expect(
    (await pool.query("select state from demo_turn where run_id = $1", [before.runId])).rows[0],
  ).toEqual({ state: "released" });
});

test("demo deadline consumes a turn while generic infrastructure failure after execution refunds", async () => {
  for (const [code, state] of [
    ["DEMO_EXECUTION_DEADLINE", "consumed"],
    ["ACTIVITY_FAILED", "released"],
  ]) {
    const current = await submit();
    await begin(current.runId);
    await store.failRun(current.runId, publicFailureForCode(code ?? "").message);
    expect(
      (await pool.query("select state from demo_turn where run_id=$1", [current.runId])).rows[0],
    ).toEqual({ state });
  }
});

test("overlapping VMs reserve independently, survive restart, and release only confirmed unused runtime", async () => {
  const first = await reserve();
  const second = await reserve(await user());
  const third = await submit(await user());

  const thirdWorkspace = await store.updateWorkspace({
    threadId: third.threadId,
    provider: "freestyle",
    state: "provisioning",
  });

  await expect(
    compute.reserve({
      workspaceId: thirdWorkspace.id,
      runId: third.runId,
      seconds: 1200,
      baselineSeconds: 0,
      providerId: null,
    }),
  ).rejects.toMatchObject({ code: "DEMO_BUDGET_RESERVED" });
  expect(await createDemoCompute(pool, 2400).outstanding(first.workspace.id)).toEqual(
    first.reservation,
  );
  await compute.settle(first.workspace.id, 110);
  await compute.settle(first.workspace.id, 110);
  expect(
    (await pool.query("select sum(seconds)::float8 seconds from demo_compute_usage")).rows[0],
  ).toEqual({ seconds: 100 });
  expect(await compute.outstanding(second.workspace.id)).not.toBeNull();
  await expect(
    compute.reserve({
      workspaceId: thirdWorkspace.id,
      runId: third.runId,
      seconds: 1100,
      baselineSeconds: 0,
      providerId: null,
    }),
  ).resolves.toBeDefined();
});

test("outstanding reservations cross UTC month boundaries and settlement allocates both months", async () => {
  const current = await reserve();
  await pool.query(
    "update demo_compute_reservation set started_at = '2026-01-31T23:55:00Z', latest_start_at = '2026-01-31T23:55:00Z' where id = $1",
    [current.reservation.id],
  );
  await expect(
    compute.reserve({
      workspaceId: current.workspace.id,
      runId: current.runId,
      seconds: 1200,
      baselineSeconds: 10,
      providerId: "vm-test",
    }),
  ).rejects.toMatchObject({ code: "DEMO_RUNTIME_EXPIRED" });
  expect(await compute.outstanding(current.workspace.id)).not.toBeNull();
  await compute.settle(current.workspace.id, 610);

  const usage = await pool.query(
    "select to_char(month,'YYYY-MM-DD') as month, seconds from demo_compute_usage order by month",
  );

  expect(usage.rows).toEqual([
    { month: "2026-01-01", seconds: 300 },
    { month: "2026-02-01", seconds: 300 },
  ]);
});

test("uncertain startup around midnight keeps capacity reserved in both possible UTC months", () => {
  expect(
    allocateRuntimeMonths(
      Date.parse("2026-01-31T23:55:00Z"),
      Date.parse("2026-02-01T00:05:00Z"),
      600,
    ),
  ).toEqual([
    { month: "2026-01-01", consumed: 0, reserved: 300 },
    { month: "2026-02-01", consumed: 300, reserved: 300 },
  ]);
});

test("confirmed absence without final runtime never fabricates consumption or releases capacity", async () => {
  const current = await reserve();
  await compute.settle(current.workspace.id, null);
  expect(await compute.outstanding(current.workspace.id)).not.toBeNull();
  expect((await pool.query("select count(*)::int count from demo_compute_usage")).rows[0]).toEqual({
    count: 0,
  });
});

test("replacement VMs reserve additional capacity while a missing VM keeps its unresolved accounting", async () => {
  const current = await reserve();
  await compute.settle(current.workspace.id, null, "vm-test");

  const replacement = await compute.reserve({
    workspaceId: current.workspace.id,
    runId: current.runId,
    seconds: 1200,
    baselineSeconds: 0,
    providerId: null,
  });

  expect(replacement.id).not.toBe(current.reservation.id);
  await compute.attach(replacement.id, "vm-replacement");
  await compute.observe(current.workspace.id, 10, "vm-replacement");
  expect((await compute.outstanding(current.workspace.id, "vm-test"))?.observed_seconds).toBe(0);
  expect(
    (await compute.outstanding(current.workspace.id, "vm-replacement"))?.observed_seconds,
  ).toBe(10);
});

test("provider startup installs the reserved runtime cap and a settled demo cannot restart", async () => {
  const { Freestyle } = await import("freestyle");
  const { createFreestyleProvider } = await import("../src/freestyle.js");
  const { loadRunnerConfig } = await import("../src/config.js");
  const { default: pino } = await import("pino");
  const { z } = await import("zod");
  const submitted = await submit();

  const workspace = await store.updateWorkspace({
    threadId: submitted.threadId,
    provider: "freestyle",
    state: "provisioning",
  });

  let vm: {
    id: string;
    state: string;
    metadata: Record<string, string>;
    totalRunSeconds: number;
    resources: { cpu: number; memory: number };
    maxRunSeconds: number;
    maxRunTotalSeconds: number;
    autoDeleteSeconds: number;
    automaticRestart: boolean;
  } | null = null;

  let creates = 0;
  let starts = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;

      if (path.endsWith("/vms") && request.method === "GET")
        return Response.json({
          vms: [],
          totalCount: vm ? 1 : 0,
          runningCount: vm?.state === "running" ? 1 : 0,
          startingCount: 0,
          pausingCount: 0,
        });

      if (path.endsWith("/vms") && request.method === "POST") {
        const body = z
          .object({
            metadata: z.record(z.string(), z.string()),
            maxRunSeconds: z.number(),
            maxRunTotalSeconds: z.number(),
            autoDeleteSeconds: z.number(),
            automaticRestart: z.boolean(),
          })
          .parse(await request.json());

        creates++;
        vm = {
          id: "vm-policy",
          state: "running",
          totalRunSeconds: 0,
          resources: { cpu: 2, memory: 4096 },
          ...body,
        };

        return Response.json({ vmId: vm.id });
      }

      if (!vm) return Response.json({ code: "NOT_FOUND", message: "missing" }, { status: 404 });

      if (path.endsWith("/pause")) {
        vm.state = "paused";
        vm.totalRunSeconds = 17;
      }

      if (path.endsWith("/start")) {
        starts++;
        vm.state = "running";
      }

      return Response.json(vm);
    },
  });

  try {
    const provider = createFreestyleProvider(
      { ...loadRunnerConfig(), freestyleApiKey: "test", freestyleMaxRunSeconds: 1200 },
      pino({ enabled: false }),
      { client: new Freestyle({ apiKey: "test", baseUrl: server.url.toString() }), compute },
    );

    const ensured = await provider.ensure(workspace, new AbortController().signal);
    expect(vm).toMatchObject({
      maxRunSeconds: 1200,
      maxRunTotalSeconds: 1200,
      automaticRestart: false,
    });
    expect(creates).toBe(1);
    const active = { ...workspace, providerId: ensured.providerId };
    await provider.pause(active, new AbortController().signal);
    expect(await compute.outstanding(workspace.id, ensured.providerId)).toBeNull();
    await expect(provider.ensure(active, new AbortController().signal)).rejects.toMatchObject({
      code: "DEMO_RUNTIME_EXPIRED",
    });
    expect(starts).toBe(0);
    expect(
      (
        await pool.query(
          "select consumed_seconds from demo_compute_reservation where workspace_id=$1",
          [workspace.id],
        )
      ).rows[0],
    ).toEqual({ consumed_seconds: 17 });
  } finally {
    await server.stop(true);
  }
});
