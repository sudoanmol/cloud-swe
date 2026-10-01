import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client, Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pino from "pino";
import { z } from "zod";
import * as schema from "@cloud-swe/db/schema/index";
import { createThreadStore } from "@cloud-swe/db/threads";
import { loadRunnerConfig } from "../src/config.js";
import { createDockerProvider } from "../src/docker.js";
import { createExecutionCoordinator } from "../src/execution-coordinator.js";
import { createPiExecutor, type PiEvent } from "../src/pi.js";
import { processResult, type CommandRequest, type WorkspaceRef } from "../src/sandbox.js";

type InjectedFactory = NonNullable<
  NonNullable<Parameters<typeof createPiExecutor>[1]>["createAgentSession"]
>;

type InjectedSession = Awaited<ReturnType<InjectedFactory>>["session"];

type InjectedListener = Parameters<InjectedSession["subscribe"]>[0];

const liveChunkSchema = z.object({ incremental: z.literal(true), commandId: z.string().min(1) });

async function dockerInfoOk(): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = Bun.spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" });

    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 8_000);

    void child.exited.then((status) => {
      clearTimeout(timer);
      resolve(status === 0);
    });
  });
}

const dockerAvailable = await dockerInfoOk();

const provider = createDockerProvider(
  { ...loadRunnerConfig(), dockerImage: "cloud-swe-local-tests", providerTimeoutMs: 20_000 },
  pino({ enabled: false }),
);

const workspaceId = randomUUID();

const workspace: WorkspaceRef = {
  id: workspaceId,
  threadId: randomUUID(),
  name: `cloud-swe-${workspaceId}`,
  provider: "docker",
  providerId: null,
  generation: 1,
};

const baseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:password@localhost:5432/cloud-swe";

const database = `cloud_swe_progress_${randomUUID().replaceAll("-", "")}`;

const databaseUrl = new URL(baseUrl);

databaseUrl.pathname = `/${database}`;

const admin = new Client({ connectionString: baseUrl });

const pool = new Pool({ connectionString: databaseUrl.toString() });

const db = drizzle(pool, { schema });

const store = createThreadStore(db);

const userId = randomUUID();

const attemptId = "attempt-progress";

let runId: string;

let ownershipToken: string;

let databaseCreated = false;

beforeAll(async () => {
  if (!dockerAvailable) return;
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  databaseCreated = true;
  await migrate(db, {
    migrationsFolder: new URL("../../../packages/db/src/migrations", import.meta.url).pathname,
  });
  await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Progress test', $2)`, [
    userId,
    `${userId}@example.test`,
  ]);

  const submission = await store.submitThread({
    userId,
    prompt: "progress",
    clientMessageId: randomUUID(),
    maxActiveRuns: 1,
  });

  runId = submission.runId;
  await store.startRun(runId);

  const record = await store.updateWorkspace({
    threadId: submission.threadId,
    provider: "docker",
    state: "provisioning",
  });

  Object.assign(workspace, {
    id: record.id,
    threadId: record.threadId,
    name: record.name,
    generation: record.generation,
  });
  ownershipToken = (
    await store.claimExecutionOwnership({ runId, attemptId, generation: workspace.generation })
  ).token;
  const prepared = await provider.ensure(workspace, AbortSignal.timeout(60_000));
  workspace.providerId = prepared.providerId;
  await store.updateWorkspace({
    threadId: workspace.threadId,
    state: "running",
    providerId: prepared.providerId,
  });

  const created = await provider.exec(
    workspace,
    { command: "mkdir -p /workspace" },
    AbortSignal.timeout(30_000),
  );

  if (created.kind !== "completed" || created.statusCode !== 0)
    throw new Error("workspace setup failed");
}, 90_000);

afterAll(async () => {
  if (!dockerAvailable) return;

  try {
    if (workspace.providerId) await provider.delete(workspace, AbortSignal.timeout(30_000));
  } finally {
    await pool.end();

    if (databaseCreated) await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
    await admin.end();
  }
}, 40_000);

function coordinator() {
  return createExecutionCoordinator({
    providers: { docker: provider, modal: provider },
    store,
    config: {
      providerTimeoutMs: 20_000,
      commandReconcileTimeoutMs: 10_000,
      commandOutputMaxBytes: 65_536,
      progressIntervalMs: 100,
    },
  });
}

test.skipIf(!dockerAvailable)(
  "the real guest reader commits incremental output before the command exits",
  async () => {
    const events: PiEvent[] = [];
    const execution = coordinator();
    const stateAtFirstChunk: string[] = [];
    let observedFirstChunk = false;

    const execute = createPiExecutor(
      {
        workspace,
        emit: async (event) => {
          const committed = await store.appendRunEvent({
            runId,
            ownershipToken,
            type: event.type,
            payload: event.payload,
            dedupeKey: `progress:${events.length}`,
          });

          events.push(event);
          const live = liveChunkSchema.safeParse(event.payload);

          if (!observedFirstChunk && event.type === "tool.output" && live.success) {
            observedFirstChunk = true;
            // A separate DB connection must see the row before the guest exits.
            // An enqueued write or an in-memory event does not establish durability.
            const reader = new Client({ connectionString: databaseUrl.toString() });
            await reader.connect();

            try {
              const visible = await reader.query(`SELECT id FROM thread_event WHERE id = $1`, [
                committed.id,
              ]);

              expect(visible.rowCount).toBe(1);

              const child = Bun.spawn([
                "docker",
                "exec",
                workspace.providerId ?? "",
                "cat",
                `/tmp/cloud-swe-commands/${workspace.id}/${live.data.commandId}/state`,
              ]);

              const stdout = await new Response(child.stdout).text();
              expect(await child.exited).toBe(0);
              stateAtFirstChunk.push(stdout.trim());
            } finally {
              await reader.end();
            }
          }
        },
        sandbox: {
          exec: async (target, request: CommandRequest, signal) => {
            const result = await execution.execute({
              workspace: target,
              request,
              runId,
              attemptId,
              ownershipToken,
              signal,
            });

            return processResult(
              result.stdout,
              result.stderr,
              result.statusCode,
              result.outputTruncated,
            );
          },
        },
      },
      {
        // Only the external model loop is replaced. The tool, guest reader,
        // coordinator, Pi writer and owned PostgreSQL transaction are real.
        createAgentSession: async (options) => {
          const tool = options.customTools?.find((candidate) => candidate.name === "remote_exec");
          const header = options.sessionManager?.getHeader();

          if (!tool || !header) throw new Error("missing tool/session header");
          const messages: InjectedSession["messages"] = [];
          let subscriber: InjectedListener | undefined;

          const assistant = {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
            api: "anthropic-messages",
            provider: "anthropic",
            model: "test",
            timestamp: 1,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          } satisfies InjectedSession["messages"][number];

          return {
            session: {
              sessionId: header.id,
              messages,
              subscribe: (listen: InjectedListener) => {
                subscriber = listen;

                return () => undefined;
              },
              prompt: async () => {
                // SAFETY: remote_exec does not read the extension context.
                const result = await tool.execute(
                  "call-progress",
                  { command: "printf 'first-chunk\\n'; sleep 1.5; printf 'second-chunk\\n'" },
                  new AbortController().signal,
                  undefined,
                  {} as never,
                );

                subscriber?.({
                  type: "tool_execution_end",
                  toolCallId: "call-progress",
                  toolName: "remote_exec",
                  result,
                  isError: false,
                });
                messages.push(assistant);
                options.sessionManager?.appendMessage(assistant);
              },
              abort: async () => undefined,
              dispose: () => undefined,
            },
          };
        },
      },
    );

    await execute({ prompt: "run", runId, attemptId, workspaceGeneration: workspace.generation });

    const incremental = events.filter(
      (event) => event.type === "tool.output" && event.payload.incremental === true,
    );

    expect(incremental.length).toBeGreaterThan(0);
    expect(incremental[0]?.payload.stream).toBe("stdout");
    expect(incremental[0]?.payload.offset).toBe(0);
    expect(String(incremental[0]?.payload.text)).toContain("first-chunk");
    expect(String(incremental[0]?.payload.text)).not.toContain("second-chunk");
    expect(stateAtFirstChunk).toEqual(["running"]);
    let offset = 0;

    for (const event of incremental) {
      expect(event.payload.offset).toBe(offset);
      offset = Number(event.payload.offset) + Number(event.payload.bytes);
    }

    const completedIndex = events.findIndex(
      (event) => event.type === "tool.completed" && event.payload.toolCallId === "call-progress",
    );

    expect(completedIndex).toBeGreaterThanOrEqual(0);
    expect(
      events.slice(completedIndex + 1).some((event) => event.payload.incremental === true),
    ).toBe(false);
    expect(String(events[completedIndex]?.payload.output)).toContain("second-chunk");
    expect(String(events[completedIndex]?.payload.output)).toContain("first-chunk");
  },
  30_000,
);

test.skipIf(!dockerAvailable)(
  "an observation read never disturbs command settlement",
  async () => {
    const result = await coordinator().execute({
      workspace,
      request: { command: "printf 'settled\\n'", timeoutMs: 20_000 },
      runId,
      attemptId,
      ownershipToken,
      signal: AbortSignal.timeout(30_000),
    });

    expect(result.state).toBe("completed");
    expect(result.stdout).toContain("settled");
    expect(result.reconciledAfterTransport).toBe(false);
  },
  30_000,
);
