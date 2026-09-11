import { ActivityFailure, ApplicationFailure, CancelledFailure } from "@temporalio/workflow";
import { describe, expect, test } from "bun:test";
import {
  lifecycleStartToCloseMs,
  normalizeWorkflowConfig,
  runFailureMessage,
} from "../src/workflows.js";

test("persists the root activity failure instead of Temporal's wrapper message", () => {
  const repositoryFailure = ApplicationFailure.nonRetryable(
    "Anonymous public GitHub checkout failed: repository is not reachable",
    "REPOSITORY_INITIALIZATION",
  );

  const activityFailure = new ActivityFailure(
    "Activity task failed",
    "executeRun",
    "activity-id",
    "MAXIMUM_ATTEMPTS_REACHED",
    "worker",
    repositoryFailure,
  );

  expect(runFailureMessage(activityFailure)).toBe(repositoryFailure.message);
});

test("does not persist a cancellation as an agent failure", () => {
  expect(runFailureMessage(new CancelledFailure("run cancelled"))).toBeUndefined();
});

describe("workflow failure mapping", () => {
  test("maps checkpoint exhaustion to a bounded storage error", () => {
    const failure = ApplicationFailure.nonRetryable(
      "checkpoint grew too large",
      "CHECKPOINT_TOO_LARGE",
    );

    expect(runFailureMessage(failure)).toBe(
      "The agent session checkpoint exceeded its storage limit",
    );
  });

  test("maps quarantine to a recovery error", () => {
    const failure = ApplicationFailure.nonRetryable("quarantined", "WORKSPACE_QUARANTINED");
    expect(runFailureMessage(failure)).toBe(
      "The workspace was quarantined after a command with an unknown outcome",
    );
  });

  test("maps replacement to a preparation error", () => {
    const failure = ApplicationFailure.nonRetryable("replaced", "WORKSPACE_REPREPARE");
    expect(runFailureMessage(failure)).toBe(
      "The workspace was replaced and must be prepared before execution can continue",
    );
  });

  test("maps run timeout and terminal states", () => {
    expect(runFailureMessage(ApplicationFailure.nonRetryable("slow", "RUN_TIMEOUT"))).toBe(
      "Run exceeded its active execution time limit",
    );
    expect(runFailureMessage(ApplicationFailure.nonRetryable("gone", "RUN_TERMINAL"))).toBe(
      "Run is no longer active",
    );
  });
});

describe("workflow configuration", () => {
  test("defaults match the documented operator settings", () => {
    const config = normalizeWorkflowConfig({});
    expect(config.idlePauseMs).toBe(30_000);
    expect(config.cleanupMs).toBe(3_600_000);
    expect(config.maxRunMs).toBe(120_000);
    expect(config.workspacePreparationTimeoutMs).toBe(420_000);
    expect(config.providerTimeoutMs).toBe(30_000);
    expect(config.commandReconcileTimeoutMs).toBe(30_000);
    expect(config.activityRetryMaxAttempts).toBe(3);
    expect(config.activityRetryWindowMs).toBe(1_500_000);
    expect(config.pending).toEqual([]);
  });

  test("pending signals are copied, not shared", () => {
    const pending = ["run-1"];
    const config = normalizeWorkflowConfig({ pending });
    expect(config.pending).toEqual(["run-1"]);
    expect(config.pending).not.toBe(pending);
  });

  test("lifecycle budget covers sequential provider and reconcile stages", () => {
    const config = normalizeWorkflowConfig({});
    expect(lifecycleStartToCloseMs(config)).toBe(2 * 30_000 + 30_000 + 30_000);
    expect(lifecycleStartToCloseMs(config)).toBeGreaterThan(
      config.providerTimeoutMs + config.commandReconcileTimeoutMs,
    );
  });
});
