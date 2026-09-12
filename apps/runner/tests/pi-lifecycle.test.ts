import { expect, test } from "bun:test";
import {
  createPiExecutor,
  type PiExecutorDependencies,
  type PiSessionMetadata,
  type PiEvent,
} from "../src/pi.js";
import { processResult } from "../src/sandbox.js";

type Factory = NonNullable<PiExecutorDependencies["createAgentSession"]>;

type Session = Awaited<ReturnType<Factory>>["session"];

type Manager = NonNullable<Parameters<Factory>[0]["sessionManager"]>;

type Subscriber = Parameters<Session["subscribe"]>[0];

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
} satisfies Session["messages"][number];

function fixture(hooks: {
  prompt: (manager: Manager, emit: Subscriber) => Promise<void>;
  emit?: (event: PiEvent) => Promise<void>;
  checkpoint?: (metadata: PiSessionMetadata) => Promise<void>;
  unsubscribe?: (emit: Subscriber) => void;
  subscribeFailure?: Error;
  abort?: () => Promise<void>;
}) {
  const calls: string[] = [];
  const checkpoints: PiSessionMetadata[] = [];
  let disposed = 0;

  const factory: Factory = async (options) => {
    const manager = options.sessionManager;
    const header = manager?.getHeader();

    if (!manager || !header) throw new Error("Expected an SDK session manager");
    let subscriber: Subscriber = () => {};

    return {
      session: {
        sessionId: header.id,
        messages: [assistant],
        subscribe: (listen) => {
          if (hooks.subscribeFailure) throw hooks.subscribeFailure;
          subscriber = listen;

          return () => {
            calls.push("unsubscribe");
            hooks.unsubscribe?.(subscriber);
          };
        },
        prompt: async () => {
          await hooks.prompt(manager, subscriber);
          calls.push("prompt-settled");
        },
        abort: async () => {
          calls.push("abort");
          await hooks.abort?.();
        },
        dispose: () => {
          disposed++;
          calls.push("dispose");
        },
      },
    };
  };

  const execute = createPiExecutor(
    {
      workspace: {
        id: "workspace",
        threadId: "thread",
        name: "test",
        provider: "docker",
        providerId: null,
        generation: 1,
      },
      sandbox: { exec: async () => processResult("", "", 0) },
      emit: async (event) => {
        calls.push("event");
        await hooks.emit?.(event);
      },
      checkpoint: async (metadata) => {
        calls.push("checkpoint");
        checkpoints.push(metadata);
        await hooks.checkpoint?.(metadata);
      },
    },
    { createAgentSession: factory },
  );

  return {
    calls,
    checkpoints,
    disposed: () => disposed,
    run: (signal?: AbortSignal) =>
      execute({
        prompt: "test",
        runId: "run",
        attemptId: "attempt",
        workspaceGeneration: 1,
        signal,
      }),
  };
}

test("cancellation drains queued events and checkpoints while the store is healthy", async () => {
  const controller = new AbortController();
  const producing = Promise.withResolvers<void>();
  const promptStopped = Promise.withResolvers<void>();
  const writesUnblocked = Promise.withResolvers<void>();
  const cancellation = new Error("cancelled with queued writes");

  const harness = fixture({
    prompt: async (manager, emit) => {
      manager.appendMessage(assistant);
      emit({ type: "agent_start" });
      emit({ type: "agent_start" });
      emit({ type: "turn_end", message: assistant, toolResults: [] });
      producing.resolve();
      await promptStopped.promise;
    },
    emit: async () => {
      await writesUnblocked.promise;
    },
    abort: async () => promptStopped.resolve(),
  });

  const outcome = harness.run(controller.signal).then(
    () => "succeeded",
    (error: Error) => error,
  );

  await producing.promise;
  controller.abort(cancellation);
  await Promise.resolve();
  writesUnblocked.resolve();

  expect(await outcome).toBe(cancellation);
  expect(harness.calls.filter((call) => call === "event")).toHaveLength(2);
  expect(harness.checkpoints).toHaveLength(2);
  expect(harness.disposed()).toBe(1);
});

test("final checkpoint commits after unsubscribe and before disposal and return", async () => {
  const harness = fixture({
    prompt: async (manager) => {
      manager.appendMessage(assistant);
    },
    unsubscribe: (emit) => {
      queueMicrotask(() => emit({ type: "agent_start" }));
    },
  });

  const result = await harness.run();
  harness.calls.push("returned");
  expect(result.text).toBe("done");
  expect(harness.calls).toEqual([
    "checkpoint",
    "prompt-settled",
    "unsubscribe",
    "checkpoint",
    "dispose",
    "returned",
  ]);
  expect(harness.checkpoints.at(-1)?.entries.some((entry) => entry.type === "message")).toBe(true);
});

test("a queued turn checkpoint cannot change when the SDK later mutates its entries", async () => {
  const blocked = Promise.withResolvers<void>();
  const queued = Promise.withResolvers<void>();

  const harness = fixture({
    emit: async () => {
      await blocked.promise;
    },
    prompt: async (manager, emit) => {
      const message = {
        role: "user",
        content: "original",
        timestamp: 1,
      } satisfies Session["messages"][number];

      manager.appendMessage(message);
      emit({ type: "agent_start" });
      emit({ type: "turn_end", message, toolResults: [] });
      message.content = "mutated";
      queued.resolve();
      manager.appendMessage(assistant);
    },
  });

  const running = harness.run();
  await queued.promise;
  blocked.resolve();
  await running;
  const turn = harness.checkpoints[1];
  expect(JSON.stringify(turn)).toContain("original");
  expect(JSON.stringify(turn)).not.toContain("mutated");
});

test("subscription initialization failure disposes the already acquired session", async () => {
  const failure = new Error("subscription setup failed");
  const harness = fixture({ prompt: async () => {}, subscribeFailure: failure });
  await expect(harness.run()).rejects.toBe(failure);
  expect(harness.disposed()).toBe(1);
});

test("SDK tool and session failure details cannot reach emitted events or checkpoints", async () => {
  const secrets = [
    "PI_BEARER_SECRET",
    "PI_BASIC_SECRET",
    "PI_COOKIE_SECRET",
    "PI_SECOND_COOKIE",
    "PI_URL_SECRET",
  ];

  const credentials = `Authorization: Bearer ${secrets[0]}\nAuthorization: Basic ${secrets[1]}\nCookie: a="${secrets[2]}"; b=${secrets[3]}\nhttps://user:${secrets[4]}@example.test`;
  const emitted: PiEvent[] = [];

  const harness = fixture({
    emit: async (event) => {
      emitted.push(event);
    },
    prompt: async (manager, emit) => {
      manager.appendMessage({ ...assistant, stopReason: "error", errorMessage: credentials });
      emit({
        type: "tool_execution_end",
        toolCallId: "call",
        toolName: "remote_exec",
        result: { content: [{ type: "text", text: credentials }], details: { cause: credentials } },
        isError: true,
      });
    },
  });

  await harness.run();

  for (const secret of secrets) {
    expect(JSON.stringify(emitted)).not.toContain(secret);
    expect(JSON.stringify(harness.checkpoints)).not.toContain(secret);
  }
});

for (const checkpointNumber of [1, 2]) {
  test(`cancellation during checkpoint ${checkpointNumber} drains its accepted write before disposal`, async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const committed = Promise.withResolvers<void>();
    const cancellation = new Error("cancelled during persistence");
    let writes = 0;
    let prompted = false;

    const harness = fixture({
      prompt: async (manager) => {
        prompted = true;
        manager.appendMessage(assistant);
      },
      checkpoint: async () => {
        if (++writes !== checkpointNumber) return;

        started.resolve();
        await committed.promise;
      },
    });

    const running = harness.run(controller.signal);

    // Attach rejection handling before delivering cancellation.
    const outcome = running.then(
      () => "succeeded",
      (error: Error) => error,
    );

    await started.promise;
    controller.abort(cancellation);
    await Promise.resolve();
    expect(harness.disposed()).toBe(0);
    committed.resolve();

    expect(await outcome).toBe(cancellation);
    expect(harness.disposed()).toBe(1);
    expect(writes).toBe(checkpointNumber);
    expect(prompted).toBe(checkpointNumber === 2);
  });
}
