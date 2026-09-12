import { expect, test } from "bun:test";
import {
  assistantDeltaDedupeKey,
  assistantStartedDedupeKey,
  assertPiCheckpointSize,
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
import { PiPersistenceOverflowError, PiPersistenceWriter } from "../src/pi-persistence.js";
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

test("Pi persistence writer preserves FIFO operation order", async () => {
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;

  const firstDone = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const writer = new PiPersistenceWriter();

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

  const writer = new PiPersistenceWriter({
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

test("Pi persistence bounds a never-resolving abort callback", async () => {
  const failure = new Error("event store unavailable");

  const writer = new PiPersistenceWriter({
    cleanupTimeoutMs: 10,
    onFailure: () => new Promise<void>(() => undefined),
  });

  const write = writer.enqueue(() => {
    throw failure;
  });

  await expect(write).rejects.toBe(failure);
  await expect(writer.drain({ timeoutMs: 10 })).rejects.toBe(failure);
});

test("Pi persistence admission is bounded by items and retained bytes", async () => {
  const writer = new PiPersistenceWriter({ itemLimit: 2, byteLimit: 5 });
  let release: (() => void) | undefined;

  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = writer.enqueue(() => blocked, { sizeBytes: 3 });
  const second = writer.enqueue(() => undefined, { sizeBytes: 2 });
  const overflow = writer.enqueue(() => undefined, { sizeBytes: 1 });

  await expect(overflow).rejects.toBeInstanceOf(PiPersistenceOverflowError);
  expect(writer.failed).toBe(true);
  release?.();
  await expect(first).resolves.toBeUndefined();
  await expect(second).resolves.toBeUndefined();
  await expect(writer.complete()).rejects.toBeInstanceOf(PiPersistenceOverflowError);
});

test("Pi persistence preflight rejects before snapshot capture", async () => {
  const writer = new PiPersistenceWriter({ itemLimit: 1, byteLimit: 8 });
  let release: (() => void) | undefined;

  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = writer.enqueue(() => blocked, { sizeBytes: 8 });
  let captured = false;

  expect(() => {
    writer.preflight(1);
    captured = true;
  }).toThrow(PiPersistenceOverflowError);
  expect(captured).toBe(false);
  release?.();
  await expect(first).resolves.toBeUndefined();
  await expect(writer.complete()).rejects.toBeInstanceOf(PiPersistenceOverflowError);
});

test("producer validation failure drains already accepted writes", async () => {
  const writer = new PiPersistenceWriter();
  const committed: string[] = [];
  let release: (() => void) | undefined;

  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = writer.enqueue(async () => {
    await blocked;
    committed.push("first");
  });

  const second = writer.enqueue(() => {
    committed.push("second");
  });

  const validationFailure = new Error("invalid checkpoint");

  writer.fail(validationFailure);
  release?.();
  await expect(first).resolves.toBeUndefined();
  await expect(second).resolves.toBeUndefined();
  await expect(writer.complete()).rejects.toBe(validationFailure);
  expect(committed).toEqual(["first", "second"]);
});

test("Pi persistence flush is a commit barrier and rejects late callback writes", async () => {
  const committed: string[] = [];
  const writer = new PiPersistenceWriter({ itemLimit: 4, byteLimit: 64 });

  const first = writer.enqueue(
    async () => {
      await Promise.resolve();
      committed.push("first");
    },
    { sizeBytes: 5 },
  );

  await writer.flush();
  await first;
  expect(committed).toEqual(["first"]);
  await writer.complete();
  await expect(writer.enqueue(() => undefined)).rejects.toThrow("closed");
});

test("Pi persistence cleanup interrupts a blocked consumer and admits no later writes", async () => {
  const writer = new PiPersistenceWriter({ cleanupTimeoutMs: 5_000 });
  const commits: string[] = [];
  let release: (() => void) | undefined;

  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });

  const cancellation = new AbortController();

  const first = writer.enqueue(
    async () => {
      await blocked;
      commits.push("first");
    },
    { sizeBytes: 1 },
  );

  const second = writer.enqueue(
    () => {
      commits.push("second");
    },
    { sizeBytes: 1 },
  );

  const completion = writer.complete({ signal: cancellation.signal });
  cancellation.abort();
  await expect(completion).rejects.toMatchObject({ code: "PERSISTENCE_CLEANUP_FAILED" });
  await expect(second).rejects.toThrow();
  release?.();
  await expect(first).rejects.toThrow();
  expect(commits).toEqual(["first"]);
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
  expect(timeout.diagnostic).not.toContain("deadline");

  const credentialBearing = normalizePiCommandResult(
    transportResult("unknown", "Authorization: Bearer test-secret"),
    128,
  );

  expect(credentialBearing.diagnostic).not.toContain("test-secret");
  expect(credentialBearing.error).not.toContain("test-secret");
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
  expect(PI_TOOL_NAMES).toEqual(["remote_exec", "remote_read", "remote_write", "remote_edit"]);
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
  prompt: string | undefined;
  expandPromptTemplates: boolean | undefined;
}

function createSessionHarness() {
  const harness: SessionHarness = {
    subscriber: undefined,
    options: undefined,
    aborts: 0,
    disposes: 0,
    prompt: undefined,
    expandPromptTemplates: undefined,
  };

  const createAgentSession: SessionFactory = async (options) => {
    harness.options = options;

    return {
      session: {
        sessionId: options.sessionManager?.getHeader()?.id ?? "session-injected",
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
        prompt: async (text, options) => {
          harness.prompt = text;
          harness.expandPromptTemplates = options?.expandPromptTemplates;
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

test("Pi session creation cancellation disposes a session that resolves late", async () => {
  const base = createSessionHarness();
  let release: (() => void) | undefined;

  const creation = new Promise<void>((resolve) => {
    release = resolve;
  });

  const delayedFactory: SessionFactory = async (options) => {
    await creation;

    return base.createAgentSession(options);
  };

  const signal = new AbortController();

  const execute = createPiExecutor(
    {
      sandbox: stubSandbox(async () => processResult("output", "", 0)),
      workspace: testWorkspace,
      emit: async () => undefined,
    },
    { createAgentSession: delayedFactory },
  );

  const running = execute({
    prompt: "do it",
    runId: "run-cancel-create",
    attemptId: "attempt-cancel-create",
    workspaceGeneration: testWorkspace.generation,
    signal: signal.signal,
  });

  signal.abort();
  await expect(running).rejects.toBeDefined();
  release?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(base.harness.disposes).toBe(1);
});

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
  expect(options.tools).toEqual(["remote_exec", "remote_read", "remote_write", "remote_edit"]);
  expect(options.customTools.map((tool) => tool.name).sort()).toEqual([
    "remote_edit",
    "remote_exec",
    "remote_read",
    "remote_write",
  ]);
  expect(options.resourceLoader.getExtensions().extensions).toEqual([]);
  expect(options.resourceLoader.getSkills().skills).toEqual([]);
  expect(options.resourceLoader.getPrompts().prompts).toEqual([]);
  expect(options.resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
  expect(options.resourceLoader.getSystemPrompt()).toBeUndefined();
  const append = options.resourceLoader.getAppendSystemPrompt().join("\n");
  expect(append).toContain("remote Linux sandbox");
  expect(append).toContain("All GitHub writes must use the first-class Git and PR tools");
  expect(append).toContain(`"workspaceGeneration":${testWorkspace.generation}`);
  expect(append).toContain('"workingDirectory":"/workspace"');

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

test("Pi checkpoints do not persist provider error bodies or diagnostics", async () => {
  const base = createSessionHarness();
  const checkpoints: PiSessionMetadata[] = [];

  const execute = createPiExecutor(
    {
      sandbox: stubSandbox(async () => processResult("output", "", 0)),
      workspace: testWorkspace,
      thinkingLevel: "high",
      emit: async () => undefined,
      checkpoint: async (metadata) => {
        checkpoints.push(metadata);
      },
    },
    {
      createAgentSession: async (options) => {
        const created = await base.createAgentSession(options);
        const message = created.session.messages[0];

        if (!message || message.role !== "assistant") throw new Error("Missing assistant fixture");
        options.sessionManager?.appendMessage({
          ...message,
          errorMessage: "private-upstream-credential",
          diagnostics: [
            { type: "test", timestamp: 0, error: { message: "private-upstream-diagnostic" } },
          ],
        });

        return created;
      },
    },
  );

  await execute({
    prompt: "inspect",
    runId: "run-safe-checkpoint",
    attemptId: "attempt-safe-checkpoint",
    workspaceGeneration: 1,
  });
  expect(checkpoints.length).toBeGreaterThan(0);
  expect(JSON.stringify(checkpoints)).not.toContain("private-upstream");
  expect(base.harness.options?.thinkingLevel).toBe("high");
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

test("remote skill expansion uses captured content with native worker expansion disabled", async () => {
  const { resolveRemoteResources } = await import("../src/remote-resources.js");

  const resources = resolveRemoteResources({
    entries: [
      {
        path: "/workspace/.pi/skills/fix",
        canonical: "/workspace/.pi/skills/fix",
        kind: "directory",
      },
      {
        path: "/workspace/.pi/skills/fix/SKILL.md",
        canonical: "/workspace/.pi/skills/fix/SKILL.md",
        kind: "file",
      },
    ],
    files: [
      {
        path: "/workspace/.pi/skills/fix/SKILL.md",
        canonical: "/workspace/.pi/skills/fix/SKILL.md",
        content: "---\nname: fix\ndescription: Fix tests\n---\nCaptured remote skill body",
      },
    ],
  });

  const { harness, createAgentSession } = createSessionHarness();

  const execute = createPiExecutor(
    {
      sandbox: stubSandbox(async () => processResult("", "", 0)),
      workspace: testWorkspace,
      resources,
      emit: async () => undefined,
    },
    { createAgentSession },
  );

  await execute({
    prompt: "/skill:fix the tests",
    runId: "run-skill",
    attemptId: "attempt-skill",
    workspaceGeneration: 3,
  });
  expect(harness.prompt).toContain("Captured remote skill body");
  expect(harness.prompt).toContain("/workspace/.pi/skills/fix");
  expect(harness.expandPromptTemplates).toBe(false);
});

test("fresh, resumed and replaced attempts rebuild the appended environment", async () => {
  let entries: PiSessionMetadata["entries"] | undefined;

  for (const [attempt, generation] of [
    [1, 1],
    [2, 1],
    [3, 2],
  ] as const) {
    const { harness, createAgentSession } = createSessionHarness();
    const workspace = { ...testWorkspace, generation };

    const execute = createPiExecutor(
      {
        sandbox: stubSandbox(async () => processResult("", "", 0)),
        workspace,
        environment: {
          repositoryUrl: "https://github.com/acme/private.git",
          branch: attempt === 1 ? "main" : "feature",
          executionLimitMs: 100_000 - attempt,
          os: "Linux",
          shell: "/bin/sh",
        },
        emit: async () => {},
      },
      { createAgentSession },
    );

    const result = await execute({
      prompt: "continue",
      runId: "prompt-run",
      attemptId: String(attempt),
      workspaceGeneration: generation,
      sessionEntries: entries,
      workspace,
    });

    entries = result.session.entries;
    const append = harness.options?.resourceLoader?.getAppendSystemPrompt().join("\n");
    expect(append).toContain(`"workspaceGeneration":${generation}`);
    expect(append).toContain(`"branch":"${attempt === 1 ? "main" : "feature"}"`);
    expect(append).toContain(`"executionLimitMs":${100_000 - attempt}`);
    expect(append).toContain("Respect rejection and expiry");
    expect(harness.options?.resourceLoader?.getSystemPrompt()).toBeUndefined();
  }
});
