import { randomUUID } from "node:crypto";
import { expect, test } from "bun:test";
import type { CommandOperationRecord } from "@cloud-swe/db/thread-contracts";
import {
  CommandUnknownError,
  UnresolvedCommandError,
  createExecutionCoordinator,
  type CommandOperationStore,
} from "../src/execution-coordinator.js";
import { buildGuestCommandRequest, parseGuestCommandObservation } from "../src/guest-command.js";
import {
  processResult,
  transportResult,
  type CommandRequest,
  type SandboxProvider,
  type WorkspaceRef,
} from "../src/sandbox.js";

const workspace: WorkspaceRef = {
  id: "00000000-0000-4000-8000-000000000001",
  threadId: "00000000-0000-4000-8000-000000000002",
  name: "cloud-swe-00000000-0000-4000-8000-000000000000",
  provider: "docker",
  providerId: "cloud-swe-00000000-0000-4000-8000-000000000000",
  generation: 1,
};

function memoryStore(): CommandOperationStore & { records: Map<string, CommandOperationRecord> } {
  const records = new Map<string, CommandOperationRecord>();

  return {
    records,
    async beginCommand(input) {
      const commandId = input.commandId ?? randomUUID();
      const existing = records.get(commandId);

      if (existing) return existing;

      const record: CommandOperationRecord = {
        commandId,
        workspaceId: input.workspaceId,
        generation: input.generation,
        runId: input.runId,
        attemptId: input.attemptId,
        state: "pending",
        cancellationRequested: false,
        metadata: input.metadata,
        result: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        completedAt: null,
      };

      records.set(commandId, record);

      return record;
    },
    async readCommand(commandId) {
      return records.get(commandId) ?? null;
    },
    async listUnsettledCommands({ workspaceId, generation }) {
      return [...records.values()].filter(
        (record) =>
          record.workspaceId === workspaceId &&
          (generation === undefined || record.generation === generation) &&
          (record.state === "pending" || record.state === "running" || record.state === "unknown"),
      );
    },
    async updateCommand(input) {
      const current = records.get(input.commandId);

      if (!current) throw new Error(`missing ${input.commandId}`);

      const next = {
        ...current,
        state: input.state ?? current.state,
        cancellationRequested: input.cancellationRequested ?? current.cancellationRequested,
        metadata: input.metadata === undefined ? current.metadata : input.metadata,
        result: input.result === undefined ? current.result : input.result,
        updatedAt: new Date(),
      };

      records.set(input.commandId, next);

      return next;
    },
  };
}

function provider(exec: SandboxProvider["exec"]): SandboxProvider {
  return {
    resolve: async (current) => ({ workspace: current, disposition: "present", recovered: false }),
    ensure: async () => ({ providerId: "vm-1", disposition: "existing", recovered: false }),
    exec,
    pause: async () => ({
      action: "pause",
      outcome: "completed",
      providerId: "vm-1",
      recovered: false,
    }),
    delete: async () => ({
      action: "delete",
      outcome: "completed",
      providerId: "vm-1",
      recovered: false,
    }),
  };
}

function coordinatorFor(exec: SandboxProvider["exec"], store = memoryStore()) {
  return {
    store,
    coordinator: createExecutionCoordinator({
      providers: { docker: provider(exec) },
      store,
      config: {
        providerTimeoutMs: 5_000,
        commandReconcileTimeoutMs: 400,
        commandOutputMaxBytes: 4_096,
      },
    }),
  };
}

test("successful fenced dispatch settles from emitted output without a reconcile roundtrip", async () => {
  const calls: CommandRequest[] = [];

  const { coordinator } = coordinatorFor(async (_workspace, request) => {
    calls.push(request);

    const observationOwner = {
      commandId: "unused",
      workspace,
      runId: "run-1",
      attemptId: "attempt-1",
    };

    // The coordinator generated the real owner; parse the request we were given
    // by executing a tiny local protocol response that includes output sections.
    const commandId = /__CLOUD_SWE_RESULT__([0-9a-f-]+)/.exec(request.command)?.[1];

    if (!commandId) throw new Error("fenced command missing result marker");

    const fake = {
      ...observationOwner,
      commandId,
    };

    const fenced = buildGuestCommandRequest({
      owner: fake,
      request: { command: "printf hello", timeoutMs: 1_000 },
      outputMaxBytes: 4_096,
    });

    expect(fenced.stdin).toBe("");

    return processResult(
      [
        `__CLOUD_SWE_RESULT__${commandId}\tcompleted\t0\t0\t0`,
        `__CLOUD_SWE_STDOUT_BEGIN__${commandId}`,
        "hello",
        `__CLOUD_SWE_STDOUT_END__${commandId}`,
        `__CLOUD_SWE_STDERR_BEGIN__${commandId}`,
        "",
        `__CLOUD_SWE_STDERR_END__${commandId}`,
        "",
      ].join("\n"),
      "",
      0,
    );
  });

  const result = await coordinator.execute({
    workspace,
    request: { command: "printf hello", timeoutMs: 1_000 },
    runId: randomUUID(),
    attemptId: "attempt-1",
    signal: new AbortController().signal,
  });

  expect(result.state).toBe("completed");
  expect(result.stdout).toBe("hello");
  expect(result.reconciledAfterTransport).toBe(false);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.stdin).toBe("");
});

test("large stdin is forwarded on the provider channel", async () => {
  const stdin = "y".repeat(200_000);
  let seen: CommandRequest | undefined;

  const { coordinator } = coordinatorFor(async (_workspace, request) => {
    seen = request;
    const commandId = /__CLOUD_SWE_RESULT__([0-9a-f-]+)/.exec(request.command)?.[1];

    if (!commandId) throw new Error("missing command id");

    return processResult(
      [
        `__CLOUD_SWE_RESULT__${commandId}\tcompleted\t0\t0\t0`,
        `__CLOUD_SWE_STDOUT_BEGIN__${commandId}`,
        "ok",
        `__CLOUD_SWE_STDOUT_END__${commandId}`,
        `__CLOUD_SWE_STDERR_BEGIN__${commandId}`,
        "",
        `__CLOUD_SWE_STDERR_END__${commandId}`,
        "",
      ].join("\n"),
      "",
      0,
    );
  });

  await coordinator.execute({
    workspace,
    request: { command: "cat", stdin, timeoutMs: 1_000 },
    runId: randomUUID(),
    attemptId: "attempt-1",
    signal: new AbortController().signal,
  });
  expect(seen?.stdin).toBe(stdin);
  expect(seen && Buffer.byteLength(seen.command, "utf8")).toBeLessThan(128 * 1024);
});

test("transport loss after dispatch reconciles and holds the fence when unknown", async () => {
  let calls = 0;

  const { coordinator, store } = coordinatorFor(async () => {
    calls += 1;

    if (calls === 1) throw new Error("worker killed");

    return transportResult("unknown", "gone");
  });

  try {
    await coordinator.execute({
      workspace,
      request: { command: "sleep 5", timeoutMs: 1_000 },
      runId: randomUUID(),
      attemptId: "attempt-1",
      signal: new AbortController().signal,
    });
    throw new Error("expected unknown command");
  } catch (error) {
    expect(error).toBeInstanceOf(CommandUnknownError);

    if (error instanceof CommandUnknownError) expect(error.recovery).toBe("hold-fence");
  }

  try {
    await coordinator.execute({
      workspace,
      request: { command: "echo next", timeoutMs: 1_000 },
      runId: randomUUID(),
      attemptId: "attempt-1",
      signal: new AbortController().signal,
    });
    throw new Error("expected unresolved fence");
  } catch (error) {
    expect(error).toBeInstanceOf(UnresolvedCommandError);
  }

  expect([...store.records.values()].some((record) => record.state === "unknown")).toBe(true);
});

test("execute-path metadata mismatch persists unknown with quarantine recovery", async () => {
  const store = memoryStore();
  const begin = store.beginCommand.bind(store);
  store.beginCommand = async (input) => {
    const record = await begin(input);
    const next = { ...record, metadata: { kind: "not-guest" } };
    store.records.set(record.commandId, next);

    return next;
  };

  let calls = 0;

  const { coordinator } = coordinatorFor(async () => {
    calls += 1;

    return processResult("", "", 0);
  }, store);

  try {
    await coordinator.execute({
      workspace,
      request: { command: "echo next", timeoutMs: 1_000 },
      runId: randomUUID(),
      attemptId: "attempt-1",
      signal: new AbortController().signal,
    });
    throw new Error("expected unknown");
  } catch (error) {
    expect(error).toBeInstanceOf(CommandUnknownError);

    if (error instanceof CommandUnknownError) expect(error.recovery).toBe("quarantine-generation");
  }

  expect(calls).toBe(0);
  const persisted = [...store.records.values()][0];
  expect(persisted?.state).toBe("unknown");
  expect(persisted?.result).toEqual({
    kind: "unknown",
    reason: "persisted command ownership metadata does not match the dispatch request",
    recovery: "quarantine-generation",
  });
});

test("execute-path terminal row without a process result persists unknown", async () => {
  const store = memoryStore();
  const begin = store.beginCommand.bind(store);
  store.beginCommand = async (input) => {
    const record = await begin(input);
    const next = { ...record, state: "completed" as const, result: { kind: "garbage" } };
    store.records.set(record.commandId, next);

    return next;
  };

  const { coordinator } = coordinatorFor(async () => processResult("", "", 0), store);

  try {
    await coordinator.execute({
      workspace,
      request: { command: "echo next", timeoutMs: 1_000 },
      runId: randomUUID(),
      attemptId: "attempt-1",
      signal: new AbortController().signal,
    });
    throw new Error("expected unknown");
  } catch (error) {
    expect(error).toBeInstanceOf(CommandUnknownError);

    if (error instanceof CommandUnknownError) expect(error.recovery).toBe("quarantine-generation");
  }

  const persisted = [...store.records.values()][0];
  expect(persisted?.state).toBe("unknown");
  expect(persisted?.result).toMatchObject({
    kind: "unknown",
    recovery: "quarantine-generation",
  });
});

test("metadata mismatch quarantines the generation", async () => {
  const store = memoryStore();

  const record: CommandOperationRecord = {
    commandId: randomUUID(),
    workspaceId: workspace.id,
    generation: workspace.generation,
    runId: randomUUID(),
    attemptId: "attempt-1",
    state: "running",
    cancellationRequested: false,
    metadata: { kind: "not-guest" },
    result: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    startedAt: null,
    completedAt: null,
  };

  store.records.set(record.commandId, record);
  const { coordinator } = coordinatorFor(async () => processResult("", "", 0), store);

  try {
    await coordinator.reconcile({
      workspace,
      commandId: record.commandId,
      signal: new AbortController().signal,
    });
    throw new Error("expected unknown");
  } catch (error) {
    expect(error).toBeInstanceOf(CommandUnknownError);

    if (error instanceof CommandUnknownError) expect(error.recovery).toBe("quarantine-generation");
  }
});

test("parse treats status-only completed as needing reconcile", () => {
  const commandId = randomUUID();

  const observation = parseGuestCommandObservation(
    processResult(`__CLOUD_SWE_RESULT__${commandId}\tcompleted\t0\t0\t0\n`, "", 0),
    {
      commandId,
      workspace,
      runId: "run-1",
      attemptId: "attempt-1",
    },
  );

  expect(observation.outputAvailable).toBe(false);
});
