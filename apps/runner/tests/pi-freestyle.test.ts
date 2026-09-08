import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { randomBytes } from "node:crypto";
import { Freestyle } from "freestyle";
import { z } from "zod";

const enabled = process.env.RUN_PAID_INTEGRATION_TESTS === "1";
const required = ["FREESTYLE_API_KEY", "AI_GATEWAY_API_KEY"];
const pid = process.pid;
const root = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const dbName = `cloud_swe_paid_${pid}`;
const port = Number(process.env.BACKEND_TEST_PORT ?? 32_000 + (pid % 1_000));
const baseUrl = `http://127.0.0.1:${port}`;
const databaseUrl = `postgresql://postgres:password@127.0.0.1:5432/${dbName}`;
const runtimeEnv = {
  DATABASE_URL: databaseUrl,
  BETTER_AUTH_SECRET: `paid-${randomBytes(24).toString("hex")}`,
  BETTER_AUTH_URL: baseUrl,
  CORS_ORIGIN: baseUrl,
  NODE_ENV: "test",
  RUNNER_EXECUTION_MODE: "pi",
  RUNNER_SANDBOX_PROVIDER: "freestyle",
  FREESTYLE_API_KEY: process.env.FREESTYLE_API_KEY ?? "",
  AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY ?? "",
};
const tsxLoader = "./apps/runner/node_modules/tsx/dist/loader.mjs";
const children: ChildProcess[] = [];
const threadIds = new Set<string>();
let providerId: string | undefined;
const resultSchema = z.object({ threadId: z.uuid(), runId: z.uuid() });
const snapshotSchema = z.object({
  runs: z.array(z.object({ status: z.string() })),
  workspace: z.object({ providerId: z.string().nullable() }).nullable(),
});

function check(value: unknown, message: string): asserts value {
  expect(value, message).toBeTruthy();
}
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 3_000);
  await exited;
  clearTimeout(force);
}
async function command(command: string, args: string[], env: Record<string, string> = {}) {
  return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (part) => (stdout += part));
    child.stderr?.on("data", (part) => (stderr += part));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
function start(command: string, args: string[], extra: Record<string, string> = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: {
      ...process.env,
      ...runtimeEnv,
      RUNNER_IDLE_PAUSE_MS: "5000",
      RUNNER_CLEANUP_MS: "30000",
      ...extra,
      SKIP_ENV_VALIDATION: "",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  children.push(child);
  return child;
}
async function waitPort() {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ready) return;
    await Bun.sleep(100);
  }
  throw new Error("Timed out waiting for paid integration server");
}
async function http(path: string, init: RequestInit = {}, cookie?: string) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  const accepted = resultSchema.safeParse(body);
  if (accepted.success) threadIds.add(accepted.data.threadId);
  return { response, body, text, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}
async function setup() {
  for (const name of required) check(process.env[name], `${name} is required for paid integration`);
  const created = await command("docker", [
    "compose",
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `CREATE DATABASE ${dbName}`,
  ]);
  check(created.code === 0, "could not create paid test database");
  const migrated = await command("bun", ["run", "--cwd", "packages/db", "db:migrate"], runtimeEnv);
  check(migrated.code === 0, "paid test migration failed");
  start("node", ["--import", tsxLoader, "apps/server/src/index.ts"], {
    PORT: String(port),
    HOST: "127.0.0.1",
  });
  await waitPort();
  start("node", ["--import", tsxLoader, "apps/runner/src/index.ts", "worker"], {
    TEMPORAL_TASK_QUEUE: `paid-${pid}`,
  });
  start("node", ["--import", tsxLoader, "apps/runner/src/index.ts", "dispatcher"], {
    TEMPORAL_TASK_QUEUE: `paid-${pid}`,
  });
}
async function cleanup() {
  await Promise.all(children.map(stop));
  await command("docker", ["compose", "up", "-d", "--wait", "postgres", "temporal"]);
  for (const threadId of threadIds) {
    await command("docker", [
      "compose",
      "exec",
      "-T",
      "temporal",
      "temporal",
      "workflow",
      "terminate",
      "--workflow-id",
      `thread:${threadId}`,
      "--reason",
      "Paid integration cleanup",
    ]);
  }
  if (process.env.FREESTYLE_API_KEY) {
    const freestyle = new Freestyle({ apiKey: process.env.FREESTYLE_API_KEY });
    const vmIds = new Set([
      ...Array.from(threadIds, (threadId) => `cloud-swe-${threadId}`),
      ...(providerId ? [providerId] : []),
    ]);
    for (const id of vmIds) {
      try {
        await freestyle.vms.ref(id).delete();
      } catch {}
    }
  }
  await command("docker", [
    "compose",
    "exec",
    "-T",
    "postgres",
    "dropdb",
    "--if-exists",
    "--force",
    "--username=postgres",
    dbName,
  ]);
}
async function readEvents(cookie: string, threadId: string) {
  const response = await fetch(`${baseUrl}/api/threads/${threadId}/events`, {
    headers: { accept: "text/event-stream", cookie },
    signal: AbortSignal.timeout(120_000),
  });
  check(response.ok && response.body, `paid SSE failed: ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const type = chunk.match(/^event: (.+)$/m)?.[1];
        const data = chunk.match(/^data: (.+)$/m)?.[1];
        if (!type || !data) continue;
        const payload = z.record(z.string(), z.unknown()).parse(JSON.parse(data));
        events.push({ type, payload });
        if (type === "run.completed") return events;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return events;
}
test.skipIf(!enabled)(
  "Pi/Freestyle smoke integration",
  async () => {
    const email = `paid-${pid}@example.com`;
    const signup = await http("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ name: `paid-${pid}`, email, password: "A-valid-password-123!" }),
    });
    check(signup.response.ok && signup.cookie, "paid signup failed");
    const submitted = await http(
      "/api/threads",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt:
            "Use remote_exec to run `printf completed`, then respond with the word completed.",
          clientMessageId: `paid-${pid}`,
        }),
      },
      signup.cookie,
    );
    check(submitted.response.status === 202, `paid submit failed: ${submitted.response.status}`);
    const result = resultSchema.parse(submitted.body);
    const until = Date.now() + 120_000;
    let snapshot: z.infer<typeof snapshotSchema> | undefined;
    while (Date.now() < until) {
      const current = await http(`/api/threads/${result.threadId}`, {}, signup.cookie);
      check(current.response.ok, "paid snapshot failed");
      const parsed = snapshotSchema.parse(current.body);
      providerId = parsed.workspace?.providerId ?? providerId;
      if (parsed.runs.some((run) => run.status === "completed")) {
        snapshot = parsed;
        break;
      }
      await Bun.sleep(500);
    }
    check(snapshot, "paid Pi run did not complete");
    check(
      providerId && !providerId.startsWith("cloud-swe-"),
      "paid run did not persist a Freestyle provider id",
    );
    const events = await readEvents(signup.cookie, result.threadId);
    const types = new Set(events.map((event) => event.type));
    for (const type of [
      "assistant.started",
      "assistant.delta",
      "tool.started",
      "tool.output",
      "tool.completed",
      "run.completed",
    ]) {
      expect(types.has(type), `missing Pi-normalized event ${type}`).toBe(true);
    }
  },
  180_000,
);
if (enabled) {
  beforeAll(setup, 60_000);
  afterAll(cleanup, 60_000);
}
