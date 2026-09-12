import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ApplicationFailure } from "@temporalio/common";
import { Context, heartbeat } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { RunnerWorkflowConfig } from "../src/config.js";

const workflowsPath = new URL("../src/workflows.ts", import.meta.url).pathname;

function workflowConfig(overrides: Partial<RunnerWorkflowConfig> = {}): RunnerWorkflowConfig {
  return {
    idlePauseMs: 2_000,
    cleanupMs: 5_000,
    maxRunMs: 60_000,
    workspacePreparationTimeoutMs: 30_000,
    providerTimeoutMs: 5_000,
    commandReconcileTimeoutMs: 5_000,
    activityRetryMaxAttempts: 1,
    activityRetryWindowMs: 120_000,
    ...overrides,
  };
}

const fakeWorkspace = {
  id: "workspace-1",
  threadId: "thread-test",
  name: "cloud-swe-thread-test",
  provider: "docker",
  providerId: null,
  generation: 1,
};

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(25);
  }
}

let testEnv: TestWorkflowEnvironment;

beforeAll(async () => {
  testEnv = await TestWorkflowEnvironment.createTimeSkipping();
}, 180_000);

afterAll(async () => {
  await testEnv?.teardown();
});

async function startWorker(
  taskQueue: string,
  activities: NonNullable<Parameters<typeof Worker.create>[0]["activities"]>,
) {
  const worker = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue,
    workflowsPath,
    activities: { ownerRetention: async () => false, ...activities },
  });

  const running = worker.run();
  running.catch(() => undefined);

  return {
    worker,
    stop: async () => {
      await worker.shutdown();
      await running.catch(() => undefined);
    },
  };
}

test("idle pause runs before cleanup delete", async () => {
  const taskQueue = `test-idle-${randomUUID()}`;
  const threadId = `thread-idle-${randomUUID()}`;
  const calls: string[] = [];

  const { stop } = await startWorker(taskQueue, {
    prepareWorkspace: async () => ({ kind: "terminal" }),
    runPi: async () => undefined,
    runScripted: async () => undefined,
    runExecution: async () => undefined,
    finalizeRun: async () => undefined,
    pauseWorkspace: async () => {
      calls.push("pause");

      return { outcome: "completed" };
    },
    deleteWorkspace: async () => {
      calls.push("delete");

      return { outcome: "completed" };
    },
  });

  try {
    const handle = await testEnv.client.workflow.start("threadWorkflow", {
      workflowId: `thread:${threadId}`,
      taskQueue,
      args: [threadId, workflowConfig()],
    });

    await testEnv.sleep(2_500);
    await waitFor(() => calls.includes("pause"), "idle pause");
    expect(calls.filter((call) => call === "delete")).toHaveLength(0);
    await testEnv.sleep(6_000);
    await waitFor(() => calls.includes("delete"), "cleanup delete");
    await handle.terminate();
  } finally {
    await stop();
  }
}, 120_000);

test("a deferred pause yields to a newly signalled run", async () => {
  const taskQueue = `test-deferred-${randomUUID()}`;
  const threadId = `thread-deferred-${randomUUID()}`;
  const calls: string[] = [];
  let pauseCount = 0;

  const { stop } = await startWorker(taskQueue, {
    prepareWorkspace: async () => {
      calls.push("prepare");

      return { kind: "prepared", workspace: { ...fakeWorkspace, threadId } };
    },
    runPi: async () => undefined,
    runScripted: async () => undefined,
    runExecution: async () => {
      calls.push("execute");
    },
    finalizeRun: async () => {
      calls.push("finalize");
    },
    pauseWorkspace: async () => {
      pauseCount += 1;
      calls.push("pause");

      if (pauseCount === 1) return { outcome: "deferred", reason: "active-run" };

      return { outcome: "completed" };
    },
    deleteWorkspace: async () => {
      calls.push("delete");

      return { outcome: "completed" };
    },
  });

  try {
    const handle = await testEnv.client.workflow.start("threadWorkflow", {
      workflowId: `thread:${threadId}`,
      taskQueue,
      args: [threadId, workflowConfig()],
    });

    await testEnv.sleep(2_500);
    await waitFor(() => calls.includes("pause"), "deferred idle pause");
    await handle.signal("startRun", "run-deferred-1");
    await waitFor(() => calls.includes("execute"), "signalled run to execute");
    expect(calls).not.toContain("finalize");
    await testEnv.sleep(2_500);
    await waitFor(() => calls.filter((call) => call === "pause").length >= 2, "second idle pause");
    await handle.terminate();
  } finally {
    await stop();
  }
}, 120_000);

test("cancelling the active run finalizes it as cancelled", async () => {
  const taskQueue = `test-cancel-${randomUUID()}`;
  const threadId = `thread-cancel-${randomUUID()}`;
  const finalized: Array<{ runId: string; status: string }> = [];
  let executing = false;

  const { stop } = await startWorker(taskQueue, {
    prepareWorkspace: async () => ({
      kind: "prepared",
      workspace: { ...fakeWorkspace, threadId },
    }),
    runPi: async () => undefined,
    runScripted: async () => undefined,
    runExecution: async () => {
      executing = true;
      const pulse = setInterval(() => heartbeat(), 100);

      try {
        await Context.current().cancelled;
      } finally {
        clearInterval(pulse);
      }
    },
    finalizeRun: async (runId: string, status: string) => {
      finalized.push({ runId, status });
    },
    pauseWorkspace: async () => ({ outcome: "completed" }),
    deleteWorkspace: async () => ({ outcome: "completed" }),
  });

  try {
    const handle = await testEnv.client.workflow.start("threadWorkflow", {
      workflowId: `thread:${threadId}`,
      taskQueue,
      args: [threadId, workflowConfig()],
    });

    await handle.signal("startRun", "run-cancel-1");
    await waitFor(() => executing, "run to start executing");
    await handle.signal("cancelRun", "run-cancel-1");
    await waitFor(() => finalized.length > 0, "cancelled finalization");
    expect(finalized).toEqual([{ runId: "run-cancel-1", status: "cancelled" }]);
    await handle.terminate();
  } finally {
    await stop();
  }
}, 120_000);

test("one hundred sequential runs continue as new", async () => {
  const taskQueue = `test-can-${randomUUID()}`;
  const threadId = `thread-can-${randomUUID()}`;
  let preparations = 0;
  const finalized: unknown[] = [];

  const { stop } = await startWorker(taskQueue, {
    prepareWorkspace: async () => {
      preparations += 1;

      return { kind: "prepared", workspace: { ...fakeWorkspace, threadId } };
    },
    runPi: async () => undefined,
    runScripted: async () => undefined,
    runExecution: async () => undefined,
    finalizeRun: async (...args: never[]) => {
      finalized.push(args);
    },
    pauseWorkspace: async () => ({ outcome: "completed" }),
    deleteWorkspace: async () => ({ outcome: "completed" }),
  });

  try {
    const handle = await testEnv.client.workflow.start("threadWorkflow", {
      workflowId: `thread:${threadId}`,
      taskQueue,
      args: [threadId, workflowConfig()],
    });

    for (let index = 0; index < 100; index += 1) {
      await handle.signal("startRun", `run-can-${index}`);
    }

    await waitFor(() => preparations >= 100, "one hundred preparations", 90_000);
    expect(finalized).toHaveLength(0);
    const described = await handle.describe();
    expect(described.status.name).toBe("RUNNING");
    await handle.terminate();
  } finally {
    await stop();
  }
}, 150_000);

for (const recovery of [false, true]) {
  test(`a superseded activity cannot finalize the current owner${recovery ? " during recovery" : ""}`, async () => {
    const taskQueue = `test-owner-${randomUUID()}`;
    const threadId = `thread-owner-${randomUUID()}`;
    const finalized: string[] = [];
    let paused = false;
    let attempted = false;
    let executions = 0;

    const { stop } = await startWorker(taskQueue, {
      prepareWorkspace: async () => ({
        kind: "prepared",
        workspace: { ...fakeWorkspace, threadId },
      }),
      runExecution: async () => {
        executions++;

        if (recovery && executions === 1)
          throw ApplicationFailure.nonRetryable("workspace replaced", "WORKSPACE_REPREPARE");

        attempted = true;
        throw ApplicationFailure.nonRetryable("ownership lost", "CHECKPOINT_OWNERSHIP_LOST");
      },
      finalizeRun: async (runId: string) => {
        finalized.push(runId);
      },
      pauseWorkspace: async () => {
        paused = attempted;

        return { outcome: "deferred", reason: "active-run" };
      },
      deleteWorkspace: async () => ({ outcome: "completed" }),
    });

    try {
      const handle = await testEnv.client.workflow.start("threadWorkflow", {
        workflowId: `thread:${threadId}`,
        taskQueue,
        args: [
          threadId,
          { ...workflowConfig({ idlePauseMs: 1_000 }), pending: ["superseded-run"] },
        ],
      });

      await waitFor(() => attempted, "the ownership failure");
      await testEnv.sleep(2_000);
      await waitFor(() => paused, "the superseded activity to yield to idle handling");
      expect(finalized).toEqual([]);
      await handle.terminate();
    } finally {
      await stop();
    }
  }, 30_000);
}

test("paused owners wait for new work without scheduling deletion", async () => {
  const taskQueue = `test-owner-${randomUUID()}`;
  const threadId = `thread-owner-${randomUUID()}`;
  const calls: string[] = [];

  const { stop } = await startWorker(taskQueue, {
    ownerRetention: async () => true,
    prepareWorkspace: async () => {
      calls.push("prepare");

      return { kind: "terminal" };
    },
    runExecution: async () => undefined,
    finalizeRun: async () => undefined,
    pauseWorkspace: async () => {
      calls.push("pause");

      return { outcome: "completed" };
    },
    deleteWorkspace: async () => {
      calls.push("delete");

      return { outcome: "completed" };
    },
  });

  try {
    const handle = await testEnv.client.workflow.start("threadWorkflow", {
      workflowId: `thread:${threadId}`,
      taskQueue,
      args: [threadId, workflowConfig()],
    });

    await testEnv.sleep("2 minutes");
    await waitFor(() => calls.includes("pause"), "owner idle pause");
    expect(calls).not.toContain("delete");
    await handle.signal("startRun", "owner-followup");
    await waitFor(() => calls.includes("prepare"), "owner follow-up");
    expect(calls).not.toContain("delete");
    await handle.terminate();
  } finally {
    await stop();
  }
});
