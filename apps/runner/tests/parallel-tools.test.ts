import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Client, Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createAgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createThreadStore } from "@cloud-swe/db/threads";
import * as schema from "@cloud-swe/db/schema/index";
import { createPiExecutor, type PiEvent } from "../src/pi.js";
import { createExecutionCoordinator } from "../src/execution-coordinator.js";
import { discoverRemoteResources } from "../src/remote-resources.js";
import {
  processResult,
  transportResult,
  type SandboxProvider,
  type WorkspaceRef,
} from "../src/sandbox.js";
import { z } from "zod";

const database = `audit_${randomUUID().replaceAll("-", "")}`;

const container = `cloud-swe-audit-${randomUUID()}`;

const baseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:password@localhost:5432/cloud-swe";

const url = new URL(baseUrl);

url.pathname = `/${database}`;

const admin = new Client({ connectionString: baseUrl });

const pool = new Pool({ connectionString: url.toString() });

const db = drizzle(pool, { schema });

const store = createThreadStore(db);

async function guest(command: string, stdin = "") {
  const child = Bun.spawn(["docker", "exec", "-i", container, "sh", "-lc", command], {
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return processResult(stdout, stderr, code);
}

beforeAll(async () => {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  await migrate(db, {
    migrationsFolder: new URL("../../../packages/db/src/migrations", import.meta.url).pathname,
  });
  expect(
    await Bun.spawn(
      [
        "docker",
        "run",
        "-d",
        "--name",
        container,
        "--network",
        "none",
        "cloud-swe-local-tests",
        "sleep",
        "infinity",
      ],
      { stdout: "ignore", stderr: "inherit" },
    ).exited,
  ).toBe(0);
  expect((await guest("mkdir -p /workspace")).statusCode).toBe(0);
});

afterAll(async () => {
  await Bun.spawn(["docker", "rm", "-f", container], { stdout: "ignore", stderr: "ignore" }).exited;
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
  await admin.end();
});

async function fixture(outputMaxBytes = 262144) {
  const userId = randomUUID();
  await db
    .insert(schema.user)
    .values({ id: userId, name: "Audit", email: `${userId}@example.test` });

  const submitted = await store.submitThread({
    userId,
    prompt: "audit",
    clientMessageId: randomUUID(),
    maxActiveRuns: 100,
  });

  const workspace = await store.updateWorkspace({
    threadId: submitted.threadId,
    state: "running",
    provider: "docker",
    name: `${container}-${randomUUID()}`,
    providerId: container,
  });

  const owner = await store.claimExecutionOwnership({
    runId: submitted.runId,
    attemptId: randomUUID(),
    generation: workspace.generation,
  });

  let active = 0,
    maxActive = 0;

  const provider: SandboxProvider = {
    ensure: async () => {
      throw new Error("unused ensure");
    },
    resolve: async () => {
      throw new Error("unused resolve");
    },
    pause: async () => {
      throw new Error("unused pause");
    },
    delete: async () => {
      throw new Error("unused delete");
    },
    exec: async (_workspace, request) => {
      active++;
      maxActive = Math.max(active, maxActive);

      try {
        return await guest(request.command, request.stdin);
      } finally {
        active--;
      }
    },
  };

  const coordinator = createExecutionCoordinator({
    providers: { docker: provider },
    store,
    config: {
      providerTimeoutMs: 10000,
      commandReconcileTimeoutMs: 2000,
      commandOutputMaxBytes: outputMaxBytes,
    },
  });

  const sandbox = {
    exec: async (
      ws: WorkspaceRef,
      request: Parameters<SandboxProvider["exec"]>[1],
      signal: AbortSignal,
    ) => {
      const result = await coordinator.execute({
        workspace: ws,
        request,
        runId: submitted.runId,
        attemptId: owner.attemptId,
        ownershipToken: owner.token,
        signal,
      });

      return processResult(result.stdout, result.stderr, result.statusCode, result.outputTruncated);
    },
  };

  return {
    submitted,
    workspace,
    owner,
    coordinator,
    sandbox,
    provider,
    maxActive: () => maxActive,
  };
}

test("installed SDK overlaps reads and completes a mixed batch through database and guest fencing", async () => {
  const f = await fixture();
  const executeGuest = f.provider.exec;
  const readsReady = Promise.withResolvers<void>();
  let readers = 0;
  f.provider.exec = async (workspace, request, signal) => {
    if (request.command.includes("flock -s 9") && readers < 2) {
      if (++readers === 2) readsReady.resolve();
      await readsReady.promise;
    }

    return executeGuest(workspace, request, signal);
  };

  await guest(
    'python3 -c \'from pathlib import Path; Path("/workspace/a.txt").write_text("x"*20000+"TAIL_MARKER"); Path("/workspace/b.txt").write_text("old old")\'',
  );

  const calls = [
    { id: "read-a", name: "remote_read", arguments: { path: "a.txt" } },
    { id: "read-b", name: "remote_read", arguments: { path: "b.txt" } },
    { id: "write-c", name: "remote_write", arguments: { path: "c.txt", content: "new" } },
    { id: "shell", name: "remote_exec", arguments: { command: "cat c.txt" } },
    { id: "read-again", name: "remote_read", arguments: { path: "a.txt" } },
    {
      id: "edit-failure",
      name: "remote_edit",
      arguments: { path: "b.txt", oldText: "old", newText: "new" },
    },
  ];

  let requests = 0;
  let modelSawTail = false;
  let modelSawStatus = false;

  const modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];

    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    modelSawTail ||= body.includes("TAIL_MARKER");
    modelSawStatus ||= body.includes("exit code 0");
    const turn = requests++;
    const batch = turn === 0 ? calls.slice(0, 2) : calls.slice(2);
    response.writeHead(200, { "content-type": "text/event-stream" });

    const delta =
      turn < 2
        ? {
            role: "assistant",
            tool_calls: batch.map((call, index) => ({
              index,
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          }
        : { role: "assistant", content: "done" };

    for (const choice of [
      { delta, finish_reason: null },
      { delta: {}, finish_reason: turn < 2 ? "tool_calls" : "stop" },
    ])
      response.write(
        `data: ${JSON.stringify({ id: "audit", object: "chat.completion.chunk", created: 1, model: "audit", choices: [{ index: 0, ...choice }] })}\n\n`,
      );
    response.end("data: [DONE]\n\n");
  });

  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const address = z.object({ port: z.number() }).parse(modelServer.address());

  const runtime = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async (_, update) => update(undefined),
      delete: async () => undefined,
    },
  });

  runtime.registerProvider("audit", {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "local-test",
    api: "openai-completions",
    models: [
      {
        id: "audit",
        name: "audit",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 1000,
      },
    ],
  });
  const events: PiEvent[] = [];

  try {
    const execute = createPiExecutor(
      {
        sandbox: f.sandbox,
        workspace: f.workspace,
        emit: async (event) => {
          events.push(event);
          await store.appendRunEvent({
            ...event,
            runId: f.submitted.runId,
            ownershipToken: f.owner.token,
          });
        },
        checkpoint: async (content) =>
          store.saveCheckpoint({
            runId: f.submitted.runId,
            key: "pi-session",
            generation: f.workspace.generation,
            attemptId: f.owner.attemptId,
            ownershipToken: f.owner.token,
            content,
          }),
      },
      {
        createAgentSession: (options) =>
          createAgentSession({
            ...options,
            modelRuntime: runtime,
            model: runtime.getModel("audit", "audit"),
          }),
      },
    );

    const result = await execute({
      runId: f.submitted.runId,
      attemptId: f.owner.attemptId,
      workspaceGeneration: f.workspace.generation,
      prompt: "Use the tools",
      signal: AbortSignal.timeout(20000),
    });

    expect(result.text).toBe("done");
    expect(f.maxActive()).toBe(2);
    expect(modelSawTail).toBe(true);
    expect(modelSawStatus).toBe(true);

    for (const call of calls)
      expect(
        events
          .values()
          .filter((event) => event.payload.toolCallId === call.id)
          .map((event) => event.type)
          .toArray(),
      ).toEqual(["tool.started", "tool.output", "tool.completed"]);
    const saved = await store.loadCheckpoint({ runId: f.submitted.runId, key: "pi-session" });
    expect(JSON.stringify(saved?.content)).toContain("ambiguous-literal-match");
    expect(JSON.stringify(saved?.content)).toContain('"matchCount":2');
    expect(await store.listUnsettledCommands({ workspaceId: f.workspace.id })).toEqual([]);
  } finally {
    modelServer.closeAllConnections();
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
    await store.cancelRun(f.submitted.runId);
  }
}, 30000);

test("structured Unicode edits and selected resources fit a 64 KiB coordinated output budget", async () => {
  const f = await fixture(65536);
  await guest(
    'python3 -c \'from pathlib import Path; p=Path("/workspace/.agents/skills"); p.mkdir(parents=True,exist_ok=True); (p/".ignore").write_text("ignored.md\\n"); (p/"ignored.md").write_bytes(b"x"*65537); Path("/workspace/.venv").mkdir(exist_ok=True); [(Path("/workspace/.venv")/str(n)).touch() for n in range(10001)]; (p/"included.md").write_text("---\\nname: included\\ndescription: read this\\n---\\n"+"a"*50000); Path("/workspace/unicode").write_text("😀"*6000)\'',
  );
  const { remoteFileCommand, editResultSchema } = await import("../src/remote-files.js");

  const result = await f.sandbox.exec(
    f.workspace,
    {
      command: remoteFileCommand,
      stdin: JSON.stringify({
        operation: "edit",
        path: "unicode",
        oldText: "😀".repeat(6000),
        newText: "🚀".repeat(6000),
        outputMaxBytes: 32768,
      }),
    },
    AbortSignal.timeout(10000),
  );

  expect(result.statusCode).toBe(0);
  expect(result.outputTruncated).toBe(false);
  expect(editResultSchema.parse(JSON.parse(result.stdout)).diffTruncated).toBe(true);

  const resources = await discoverRemoteResources({
    sandbox: f.sandbox,
    workspace: f.workspace,
    signal: AbortSignal.timeout(20000),
    outputMaxBytes: 65536,
  });

  expect(resources.skills.map((skill) => skill.name)).toContain("included");
  await store.cancelRun(f.submitted.runId);
}, 30000);

test("cancelling a batch reconciles both ambiguous reads and never dispatches its queued mutation", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const bothStarted = Promise.withResolvers<void>();
  let dispatched = 0;
  const running: Promise<unknown>[] = [];
  f.provider.exec = async (_workspace, request) => {
    if (!request.command.includes("write_atomic()")) return guest(request.command, request.stdin);
    running.push(guest(request.command, request.stdin));

    if (++dispatched === 2) bothStarted.resolve();
    await new Promise<void>((resolve) =>
      abort.signal.addEventListener("abort", () => resolve(), { once: true }),
    );

    return transportResult("cancelled");
  };

  const marker = `/workspace/read-${randomUUID()}`;

  const read = (index: number) =>
    f.sandbox.exec(
      f.workspace,
      { access: "read", command: `touch ${marker}-${index}; sleep 1; printf read` },
      abort.signal,
    );

  const reads = [read(1), read(2)];
  await bothStarted.promise;

  // Transport dispatch can precede journal creation; cancel only once both guests run.
  while ((await guest(`test -f ${marker}-1 && test -f ${marker}-2`)).statusCode !== 0)
    await Bun.sleep(5);

  const write = f.sandbox
    .exec(f.workspace, { command: "touch /workspace/must-not-dispatch" }, abort.signal)
    .then(
      () => false,
      () => true,
    );

  while ((await store.listUnsettledCommands({ workspaceId: f.workspace.id })).length < 3)
    await Bun.sleep(5);
  abort.abort();
  expect((await Promise.all(reads)).map((result) => result.stdout)).toEqual(["read", "read"]);
  expect(await write).toBe(true);
  expect(dispatched).toBe(2);
  await Promise.all(running);
  expect(await store.listUnsettledCommands({ workspaceId: f.workspace.id })).toEqual([]);
  await store.cancelRun(f.submitted.runId);
}, 15000);
