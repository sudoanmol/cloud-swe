import { expect, test } from "bun:test";
import {
  assistantDeltaDedupeKey,
  assistantStartedDedupeKey,
  assertPiCheckpointSize,
  buildRemoteWriteCommand,
  coordinatorTransport,
  createPiExecutor,
  createPiResourceLoader,
  normalizePiCommandResult,
  PI_TOOL_NAMES,
  piAttemptEventIdentity,
  PiCheckpointLimitError,
  scopePiAttemptEvent,
  scopeScriptedAttemptEvent,
  serializedPiCheckpointBytes,
  workspacePath,
  type PiEvent,
  type PiExecutorDependencies,
  type PiSessionMetadata,
} from "../src/pi.js";
import { OrderedPiWriter } from "../src/pi-writer.js";
import {
  CommandCancelledBeforeDispatchError,
  CommandUnknownError,
} from "../src/execution-coordinator.js";
import {
  processResult,
  SandboxProviderError,
  transportResult,
  type SandboxProvider,
  type WorkspaceRef,
} from "../src/sandbox.js";

const sessionMetadata: PiSessionMetadata = {
  sessionId: "session-1",
  provider: "vercel-ai-gateway",
  model: "model-1",
  entries: [],
  runId: "run-1",
  attemptId: "attempt-1",
  workspaceGeneration: 1,
  assistantAttempt: 1,
};

test("ordered Pi writer preserves operation order", async () => {
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;

  const firstDone = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const writer = new OrderedPiWriter();

  const first = writer.enqueue(async () => {
    order.push("first-start");
    await firstDone;
    order.push("first-end");
  });

  const second = writer.enqueue(async () => {
    order.push("second");
  });

  await Promise.resolve();
  expect(order).toEqual(["first-start"]);
  releaseFirst?.();
  await Promise.all([first, second]);
  await writer.drain();
  expect(order).toEqual(["first-start", "first-end", "second"]);
});

test("first Pi persistence failure aborts once, rejects later writes, and drains", async () => {
  const failure = new Error("event store unavailable");
  const aborts: unknown[] = [];
  const executed: string[] = [];

  const writer = new OrderedPiWriter({
    onFailure: (error) => {
      aborts.push(error);
    },
  });

  const first = writer.enqueue(async () => {
    executed.push("first");
    throw failure;
  });

  const later = writer.enqueue(async () => {
    executed.push("later");
  });

  await expect(first).rejects.toBe(failure);
  await expect(later).rejects.toBe(failure);
  await expect(writer.drain()).rejects.toBe(failure);
  expect(executed).toEqual(["first"]);
  expect(aborts).toEqual([failure]);
  expect(writer.failed).toBe(true);
});

test("nonzero process exits remain bounded tool results", () => {
  const result = normalizePiCommandResult(processResult("stdout\n", "stderr\n", 7), 128);
  expect(result.kind).toBe("nonzero");
  expect(result.statusCode).toBe(7);
  expect(result.stdout).toContain("stdout");
  expect(result.stderr).toContain("stderr");
  expect(result.diagnostic).toContain("exit code 7");
  expect(normalizePiCommandResult(processResult("output", "", 1), 128).diagnostic).toContain(
    "exit code 1",
  );
});

test("output limits mark truncation without dropping the result contract", () => {
  const result = normalizePiCommandResult(processResult("abcdefgh", "ijkl", 1), 5);
  expect(result.kind).toBe("output-limit");
  expect(result.statusCode).toBe(1);
  expect(result.outputTruncated).toBe(true);
  expect(
    Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8"),
  ).toBeLessThanOrEqual(5);
  expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(5);
  expect(Buffer.byteLength(result.diagnostic, "utf8")).toBeLessThanOrEqual(5);
});

test("coordinator transport outcomes stay distinct from process failures", () => {
  const timeout = normalizePiCommandResult(transportResult("transport-timeout", "deadline"), 128);
  const cancelled = normalizePiCommandResult(transportResult("cancelled", "caller stopped"), 128);
  const unknown = normalizePiCommandResult(transportResult("unknown", "lost response"), 128);

  expect(timeout.kind).toBe("transport-timeout");
  expect(cancelled.kind).toBe("cancelled");
  expect(unknown.kind).toBe("unknown");
  expect(timeout.statusCode).toBeNull();
  expect(timeout.diagnostic).toContain("deadline");
});

test("checkpoint size is measured in bytes and fails with a bounded error", () => {
  const size = serializedPiCheckpointBytes(sessionMetadata);
  expect(() => assertPiCheckpointSize(sessionMetadata, size)).not.toThrow();
  expect(() => assertPiCheckpointSize(sessionMetadata, size - 1)).toThrow(PiCheckpointLimitError);
  expect(() => assertPiCheckpointSize(sessionMetadata, size - 1)).toThrow(
    `configured limit is ${size - 1} bytes`,
  );
});

test("attempt and delta identities cannot collide across retries", () => {
  const first = piAttemptEventIdentity("run-1", "attempt-1");
  const retry = piAttemptEventIdentity("run-1", "attempt-2");
  expect(first).not.toBe(retry);
  expect(assistantStartedDedupeKey("run-1", "attempt-1", 1)).not.toBe(
    assistantStartedDedupeKey("run-1", "attempt-2", 1),
  );
  expect(assistantDeltaDedupeKey("run-1", "attempt-1", 1, 0)).not.toBe(
    assistantDeltaDedupeKey("run-1", "attempt-1", 1, 1),
  );
});

test("Pi resource loading is empty and cannot discover worker-local resources", () => {
  const loader = createPiResourceLoader();
  expect(loader.getExtensions().extensions).toEqual([]);
  expect(loader.getSkills().skills).toEqual([]);
  expect(loader.getPrompts().prompts).toEqual([]);
  expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
  expect(PI_TOOL_NAMES).toEqual(["remote_exec", "remote_read", "remote_write"]);
});

test("remote_write quotes the dirname command substitution for spaces", () => {
  const command = buildRemoteWriteCommand("nested directory/file name.txt");
  expect(command).toBe(
    `mkdir -p -- "$(dirname -- '/workspace/nested directory/file name.txt')" && cat > '/workspace/nested directory/file name.txt'`,
  );
});

test("remote paths remain inside the guest workspace", () => {
  expect(workspacePath("src/file.ts")).toBe("/workspace/src/file.ts");
  expect(() => workspacePath("../../worker-secret")).toThrow("inside /workspace");
});

test("typed coordinator errors map to transport outcomes without string matching", () => {
  expect(
    coordinatorTransport(
      new CommandUnknownError({
        workspaceId: "ws-1",
        generation: 1,
        commandId: "cmd-1",
        reason: "lost",
        recovery: "hold-fence",
      }),
    )?.kind,
  ).toBe("unknown");
  expect(coordinatorTransport(new CommandCancelledBeforeDispatchError("cmd-1"))?.kind).toBe(
    "cancelled",
  );
  expect(coordinatorTransport(new SandboxProviderError("timeout", "exec"))?.kind).toBe(
    "transport-timeout",
  );
  expect(coordinatorTransport(new SandboxProviderError("cancelled", "exec"))?.kind).toBe(
    "cancelled",
  );
  expect(coordinatorTransport(new Error("plain worker failure"))).toBeUndefined();
});

const testWorkspace: WorkspaceRef = {
  id: "workspace-1",
  threadId: "thread-1",
  name: "cloud-swe-thread-1",
  provider: "docker",
  providerId: null,
  generation: 3,
};

function stubSandbox(exec: SandboxProvider["exec"]): Pick<SandboxProvider, "exec"> {
  return { exec };
}

type SessionFactory = NonNullable<PiExecutorDependencies["createAgentSession"]>;

type SessionOptions = Parameters<SessionFactory>[0];

type TestSession = Awaited<ReturnType<SessionFactory>>["session"];

interface SessionHarness {
  subscriber: Parameters<TestSession["subscribe"]>[0] | undefined;
  options: SessionOptions | undefined;
  aborts: number;
  disposes: number;
}

function createSessionHarness() {
  const harness: SessionHarness = {
    subscriber: undefined,
    options: undefined,
    aborts: 0,
    disposes: 0,
  };

  const createAgentSession: SessionFactory = async (options) => {
    harness.options = options;

    return {
      session: {
        sessionId: "session-injected",
        messages: [
          {
            role: "assistant" as const,
            content: [{ type: "text", text: "injected done" }],
            stopReason: "stop" as const,
            api: "anthropic-messages",
            provider: "anthropic",
            model: "test",
            timestamp: 0,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
        ],
        subscribe: (subscriber: Parameters<TestSession["subscribe"]>[0]) => {
          harness.subscriber = subscriber;

          return () => undefined;
        },
        prompt: async () => {
          harness.subscriber?.({ type: "agent_start" });
          harness.subscriber?.({
            type: "turn_end",
            message: { role: "user", content: "test", timestamp: 0 },
            toolResults: [],
          });
        },
        abort: async () => {
          harness.aborts += 1;
        },
        dispose: () => {
          harness.disposes += 1;
        },
      },
    };
  };

  return { harness, createAgentSession };
}

test("injected sessions receive only custom remote tools and empty resources", async () => {
  const { harness, createAgentSession } = createSessionHarness();
  const events: PiEvent[] = [];
  const checkpoints: PiSessionMetadata[] = [];

  const execute = createPiExecutor(
    {
      sandbox: stubSandbox(async () => processResult("hi", "", 0)),
      workspace: testWorkspace,
      piProvider: "vercel-ai-gateway",
      piModel: "model-1",
      aiGatewayApiKey: "test-key",
      emit: async (event) => {
        events.push(event);
      },
      checkpoint: async (metadata) => {
        checkpoints.push(metadata);
      },
    },
    { createAgentSession: createAgentSession },
  );

  const output = await execute({
    prompt: "do it",
    runId: "run-9",
    attemptId: "attempt-7",
    workspaceGeneration: testWorkspace.generation,
    sessionEntries: undefined,
    workspace: testWorkspace,
  });

  expect(output.text).toBe("injected done");

  const options = harness.options;

  if (!options?.customTools || !options.resourceLoader)
    throw new Error("Session options were not captured");

  expect(options.noTools).toBe("all");
  expect(options.tools).toEqual(["remote_exec", "remote_read", "remote_write"]);
  expect(options.customTools.map((tool) => tool.name).sort()).toEqual([
    "remote_exec",
    "remote_read",
    "remote_write",
  ]);
  expect(options.resourceLoader.getExtensions().extensions).toEqual([]);
  expect(options.resourceLoader.getSkills().skills).toEqual([]);
  expect(options.resourceLoader.getPrompts().prompts).toEqual([]);
  expect(options.resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
  expect(options.resourceLoader.getSystemPrompt()).toBeUndefined();

  const checkpoint = checkpoints.at(-1);
  expect(checkpoint?.attemptId).toBe("attempt-7");
  expect(checkpoint?.workspaceGeneration).toBe(testWorkspace.generation);
  expect(checkpoint?.runId).toBe("run-9");
  expect(events.some((event) => event.type === "assistant.started")).toBe(true);

  for (const event of events) {
    expect(event.payload.runId).toBe("run-9");
    expect(event.payload.attemptId).toBe("attempt-7");
    expect(event.dedupeKey).toContain("attempt-7");
  }
});

test("attempt identity flows into tool events and survives a retry", async () => {
  const first = createSessionHarness();
  const firstEvents: PiEvent[] = [];

  const runFirst = createPiExecutor(
    {
      sandbox: stubSandbox(async () => processResult("first-output", "", 0)),
      workspace: testWorkspace,
      emit: async (event) => {
        firstEvents.push(event);
      },
    },
    { createAgentSession: first.createAgentSession },
  );

  await runFirst({
    prompt: "first",
    runId: "run-9",
    attemptId: "attempt-1",
    workspaceGeneration: testWorkspace.generation,
  });

  const second = createSessionHarness();
  const secondEvents: PiEvent[] = [];

  const runSecond = createPiExecutor(
    {
      sandbox: stubSandbox(async () => processResult("second-output", "", 0)),
      workspace: testWorkspace,
      emit: async (event) => {
        secondEvents.push(event);
      },
    },
    { createAgentSession: second.createAgentSession },
  );

  await runSecond({
    prompt: "retry",
    runId: "run-9",
    attemptId: "attempt-2",
    workspaceGeneration: testWorkspace.generation,
  });

  const firstKeys = firstEvents.map((event) => event.dedupeKey);
  const secondKeys = secondEvents.map((event) => event.dedupeKey);
  expect(firstKeys.length).toBeGreaterThan(0);
  expect(secondKeys.length).toBeGreaterThan(0);
  expect(firstKeys.some((key) => key.includes("attempt-1"))).toBe(true);
  expect(secondKeys.some((key) => key.includes("attempt-2"))).toBe(true);

  for (const key of firstKeys) expect(key.split("attempt-1").length - 1).toBe(1);

  for (const key of secondKeys) expect(key.split("attempt-2").length - 1).toBe(1);
  expect(new Set([...firstKeys, ...secondKeys]).size).toBe(firstKeys.length + secondKeys.length);
});

test("activity envelope keeps authoritative ids and never double-prefixes Pi keys", () => {
  const scoped = scopePiAttemptEvent("run-1", "attempt-2", {
    type: "tool.output",
    dedupeKey: "run:run-1:attempt:attempt-2:tool:t:output:0:abc",
    payload: { runId: "evil", attemptId: "evil", output: "x" },
  });

  expect(scoped.dedupeKey).toBe("run:run-1:attempt:attempt-2:tool:t:output:0:abc");
  expect(scoped.payload.runId).toBe("run-1");
  expect(scoped.payload.attemptId).toBe("attempt-2");
  expect(scoped.payload.output).toBe("x");

  const scripted = scopeScriptedAttemptEvent("run-1", "attempt-2", {
    type: "tool.output",
    dedupeKey: "run:run-1:tool-output",
    payload: { runId: "run-1", output: "y" },
  });

  expect(scripted.dedupeKey).toBe("run:run-1:attempt:attempt-2:run:run-1:tool-output");
  expect(scripted.payload.runId).toBe("run-1");
  expect(scripted.payload.attemptId).toBe("attempt-2");
});

test("a persistence failure aborts the session and surfaces from drain", async () => {
  const { harness, createAgentSession } = createSessionHarness();
  const failure = new Error("event store unavailable");

  const execute = createPiExecutor(
    {
      sandbox: stubSandbox(async () => processResult("output", "", 0)),
      workspace: testWorkspace,
      emit: async () => {
        throw failure;
      },
    },
    { createAgentSession: createAgentSession },
  );

  await expect(
    execute({
      prompt: "do it",
      runId: "run-9",
      attemptId: "attempt-1",
      workspaceGeneration: testWorkspace.generation,
    }),
  ).rejects.toBe(failure);
  expect(harness.aborts).toBe(1);
  expect(harness.disposes).toBe(1);
});
