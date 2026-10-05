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
    // Force history replay and avoid retained sticky tasks after test worker shutdown.
    maxCachedWorkflows: 0,
    taskQueue,
    workflowsPath,
    activities: {
      idleDeferralMs: async () => 0,
      ...activities,
    },
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

test("a deferred pause retries after the idle period, not the deletion delay", async () => {
  const taskQueue = `test-deferred-retry-${randomUUID()}`;
  const threadId = `thread-deferred-retry-${randomUUID()}`;
  let pauseCount = 0;

  const { stop } = await startWorker(taskQueue, {
    prepareWorkspace: async () => ({
      kind: "prepared",
      workspace: { ...fakeWorkspace, threadId },
    }),
    runPi: async () => undefined,
    runScripted: async () => undefined,
    runExecution: async () => undefined,
    finalizeRun: async () => undefined,
    pauseWorkspace: async () => {
      pauseCount += 1;

      return pauseCount === 1
        ? { outcome: "deferred", reason: "active-run" }
        : { outcome: "completed" };
    },
  });

  try {
    const handle = await testEnv.client.workflow.start("threadWorkflow", {
      workflowId: `thread:${threadId}`,
      taskQueue,
      args: [threadId, workflowConfig()],
    });

    await testEnv.sleep(2_500);
    await waitFor(() => pauseCount === 1, "deferred idle pause");
    await testEnv.sleep(4_500);
    await waitFor(() => pauseCount === 2, "pause retry after the idle period");
    await handle.terminate();
  } finally {
    await stop();
  }
}, 120_000);

for (const recovering of [false, true])
  test(`cancelling ${recovering ? "replacement" : "initial"} execution finalizes it as cancelled`, async () => {
    const taskQueue = `test-cancel-${randomUUID()}`;
    const threadId = `thread-cancel-${randomUUID()}`;
    const finalized: Array<{ runId: string; status: string }> = [];
    let executing = false;
    let attempts = 0;
    let cancellationReceived = false;

    const { stop } = await startWorker(taskQueue, {
      prepareWorkspace: async () => ({
        kind: "prepared",
        workspace: { ...fakeWorkspace, threadId },
      }),
      runPi: async () => undefined,
      runScripted: async () => undefined,
      runExecution: async () => {
        if (recovering && attempts++ === 0)
          throw ApplicationFailure.nonRetryable("reprepare", "WORKSPACE_REPREPARE");
        executing = true;
        const pulse = setInterval(() => heartbeat(), 100);

        try {
          await Context.current().cancelled;
        } finally {
          cancellationReceived = true;
          clearInterval(pulse);
        }
      },
      finalizeRun: async (runId: string, status: string) => {
        finalized.push({ runId, status });
      },
      pauseWorkspace: async () => ({ outcome: "completed" }),
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
      expect(cancellationReceived).toBe(true);
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

test("a paused workspace is kept until new work arrives", async () => {
  const taskQueue = `test-retain-${randomUUID()}`;
  const threadId = `thread-retain-${randomUUID()}`;
  const calls: string[] = [];

  const { stop } = await startWorker(taskQueue, {
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
  });

  try {
    const handle = await testEnv.client.workflow.start("threadWorkflow", {
      workflowId: `thread:${threadId}`,
      taskQueue,
      args: [threadId, workflowConfig()],
    });

    await testEnv.sleep(2_500);
    await waitFor(() => calls.includes("pause"), "idle pause");
    // Nothing else is scheduled while it stays paused. Time skipping may wait
    // in real time while another activity holds the server clock.
    await testEnv.sleep(10_000);
    expect(calls).toEqual(["pause"]);
    await handle.signal("startRun", "followup");
    await waitFor(() => calls.includes("prepare"), "follow-up");
    await handle.terminate();
  } finally {
    await stop();
  }
}, 30_000);

test("a wake request resumes a paused workspace and the idle pause runs again", async () => {
  const taskQueue = `test-wake-${randomUUID()}`;
  const threadId = `thread-wake-${randomUUID()}`;
  const calls: string[] = [];

  const { stop } = await startWorker(taskQueue, {
    prepareWorkspace: async () => ({ kind: "terminal" }),
    runExecution: async () => undefined,
    finalizeRun: async () => undefined,
    wakeWorkspace: async () => {
      calls.push("wake");
    },
    pauseWorkspace: async () => {
      calls.push("pause");

      return { outcome: "completed" };
    },
  });

  try {
    const handle = await testEnv.client.workflow.start("threadWorkflow", {
      workflowId: `thread:${threadId}`,
      taskQueue,
      args: [threadId, workflowConfig()],
    });

    await waitFor(() => calls.includes("pause"), "first idle pause");
    await handle.signal("wakeWorkspace");
    await waitFor(() => calls.includes("wake"), "wake");
    await testEnv.sleep(2_500);
    await waitFor(() => calls.filter((call) => call === "pause").length === 2, "second pause");
    expect(calls).toEqual(["pause", "wake", "pause"]);
    await handle.terminate();
  } finally {
    await stop();
  }
}, 30_000);

test("Git approval releases execution, survives worker restart, and resumes on a decision signal", async () => {
  const taskQueue = `test-git-${randomUUID()}`;
  const threadId = `thread-git-${randomUUID()}`;
  const calls: string[] = [];
  let pendingApproval = true;
  let executions = 0;

  const activities = {
    prepareWorkspace: async () => {
      calls.push("prepare");

      return { kind: "prepared", workspace: fakeWorkspace };
    },
    runExecution: async () => {
      executions++;
      calls.push("execute");

      return executions === 1
        ? {
            kind: "awaiting_approval",
            operationId: "operation",
            expiresAt: Date.now() + 86_400_000,
          }
        : undefined;
    },
    pauseForApproval: async () => {
      calls.push("approval-pause");

      return { outcome: "completed" };
    },
    approvalStatus: async () => ({ pending: pendingApproval, expiresAt: Date.now() + 86_400_000 }),
    resumeApproval: async () => {
      calls.push("resume-budget");
    },
    pauseWorkspace: async () => ({ outcome: "completed" }),
    finalizeRun: async () => {
      calls.push("finalize");
    },
  };

  let worker = await startWorker(taskQueue, activities);

  const handle = await testEnv.client.workflow.start("threadWorkflow", {
    workflowId: `thread:${threadId}`,
    taskQueue,
    args: [threadId, workflowConfig()],
  });

  try {
    await handle.signal("startRun", "git-run");
    await waitFor(() => executions === 1, "approval request");
    await testEnv.sleep(2_500);
    await waitFor(() => calls.includes("approval-pause"), "approval wait");
    await worker.stop();
    expect(executions).toBe(1);
    pendingApproval = false;
    await handle.signal("gitDecision", "git-run");
    worker = await startWorker(taskQueue, activities);
    await waitFor(() => executions === 2, "approved resume");
    expect(calls.slice(0, 6)).toEqual([
      "prepare",
      "execute",
      "approval-pause",
      "prepare",
      "resume-budget",
      "execute",
    ]);
    expect(calls).not.toContain("finalize");
    await handle.terminate();
  } finally {
    await worker.stop();
  }
}, 120_000);

test("questions release execution, survive worker restart, and wait without a timeout", async () => {
  const taskQueue = `test-questions-${randomUUID()}`;
  const threadId = `thread-questions-${randomUUID()}`;
  const calls: string[] = [];
  let pendingQuestions = true;
  let executions = 0;

  const activities = {
    prepareWorkspace: async () => {
      calls.push("prepare");

      return { kind: "prepared", workspace: fakeWorkspace };
    },
    runExecution: async () => {
      executions += 1;
      calls.push("execute");

      return executions === 1
        ? { kind: "awaiting_questions" as const, requestId: "request" }
        : undefined;
    },
    pauseForQuestions: async () => {
      calls.push("questions-pause");

      return { outcome: "completed" as const };
    },
    questionStatus: async () => ({ pending: pendingQuestions }),
    resumeQuestions: async () => {
      calls.push("resume-questions");
    },
    pauseWorkspace: async () => ({ outcome: "completed" as const }),
    finalizeRun: async () => {
      calls.push("finalize");
    },
  };

  let worker = await startWorker(taskQueue, activities);

  const handle = await testEnv.client.workflow.start("threadWorkflow", {
    workflowId: `thread:${threadId}`,
    taskQueue,
    args: [threadId, workflowConfig()],
  });

  try {
    await handle.signal("startRun", "question-run");
    await waitFor(() => executions === 1, "question request");
    expect(calls).not.toContain("questions-pause");
    await testEnv.sleep(2_500);
    await waitFor(() => calls.includes("questions-pause"), "question wait");
    await Bun.sleep(100);
    expect(executions).toBe(1);
    await worker.stop();
    pendingQuestions = false;
    await handle.signal("questionAnswered", "question-run");
    worker = await startWorker(taskQueue, activities);
    await waitFor(() => executions === 2, "answered resume");
    expect(calls.slice(0, 6)).toEqual([
      "prepare",
      "execute",
      "questions-pause",
      "prepare",
      "resume-questions",
      "execute",
    ]);
    expect(calls).not.toContain("finalize");
    await handle.terminate();
    await Worker.runReplayHistory({ workflowsPath }, await handle.fetchHistory());
  } finally {
    await worker.stop();
  }
}, 120_000);

test("a question answered within the idle period resumes without pausing", async () => {
  const taskQueue = `test-quick-answer-${randomUUID()}`;
  const threadId = `thread-quick-answer-${randomUUID()}`;
  const calls: string[] = [];
  let pendingQuestions = true;
  let executions = 0;

  const { stop } = await startWorker(taskQueue, {
    prepareWorkspace: async () => ({
      kind: "prepared",
      workspace: fakeWorkspace,
    }),
    runExecution: async () => {
      executions += 1;

      return executions === 1
        ? { kind: "awaiting_questions" as const, requestId: "request" }
        : undefined;
    },
    pauseForQuestions: async () => {
      calls.push("questions-pause");

      return { outcome: "completed" as const };
    },
    questionStatus: async () => ({ pending: pendingQuestions }),
    resumeQuestions: async () => undefined,
    pauseWorkspace: async () => ({ outcome: "completed" as const }),
    finalizeRun: async () => undefined,
  });

  try {
    const handle = await testEnv.client.workflow.start("threadWorkflow", {
      workflowId: `thread:${threadId}`,
      taskQueue,
      args: [threadId, workflowConfig()],
    });

    await handle.signal("startRun", "quick-run");
    await waitFor(() => executions === 1, "question request");
    pendingQuestions = false;
    await handle.signal("questionAnswered", "quick-run");
    await waitFor(() => executions === 2, "answered resume");
    expect(calls).not.toContain("questions-pause");
    await handle.terminate();
  } finally {
    await stop();
  }
}, 120_000);

test("review panel activity defers the idle pause", async () => {
  const taskQueue = `test-review-idle-${randomUUID()}`;
  const threadId = `thread-review-idle-${randomUUID()}`;
  const deferrals = [1_500, 0];
  let pauses = 0;

  const { stop } = await startWorker(taskQueue, {
    idleDeferralMs: async () => deferrals.shift() ?? 0,
    pauseWorkspace: async () => {
      pauses += 1;

      return { outcome: "completed" as const };
    },
  });

  try {
    const handle = await testEnv.client.workflow.start("threadWorkflow", {
      workflowId: `thread:${threadId}`,
      taskQueue,
      args: [threadId, workflowConfig()],
    });

    await testEnv.sleep(2_500);
    await Bun.sleep(200);
    expect(pauses).toBe(0);
    await testEnv.sleep(1_500);
    await waitFor(() => pauses === 1, "idle pause after the review went quiet");
    expect(deferrals).toEqual([]);
    await handle.terminate();
  } finally {
    await stop();
  }
}, 120_000);

test("a deferred pause during a question wait retries after another idle period", async () => {
  const taskQueue = `test-question-retry-${randomUUID()}`;
  const threadId = `thread-question-retry-${randomUUID()}`;
  let executions = 0;
  let pauses = 0;

  const { stop } = await startWorker(taskQueue, {
    prepareWorkspace: async () => ({ kind: "prepared", workspace: fakeWorkspace }),
    runExecution: async () => {
      executions += 1;

      return executions === 1
        ? { kind: "awaiting_questions" as const, requestId: "request" }
        : undefined;
    },
    pauseForQuestions: async () => {
      pauses += 1;

      return pauses === 1
        ? { outcome: "deferred" as const, reason: "unsettled-command" as const }
        : { outcome: "completed" as const };
    },
    questionStatus: async () => ({ pending: true }),
    pauseWorkspace: async () => ({ outcome: "completed" as const }),
    finalizeRun: async () => undefined,
  });

  try {
    const handle = await testEnv.client.workflow.start("threadWorkflow", {
      workflowId: `thread:${threadId}`,
      taskQueue,
      args: [threadId, workflowConfig()],
    });

    await handle.signal("startRun", "question-retry-run");
    await waitFor(() => executions === 1, "question request");
    await testEnv.sleep(2_500);
    await waitFor(() => pauses === 1, "deferred question pause");
    await testEnv.sleep(2_500);
    await waitFor(() => pauses === 2, "question pause retry");
    await handle.terminate();
  } finally {
    await stop();
  }
}, 120_000);
