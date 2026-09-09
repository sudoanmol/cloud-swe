import { ActivityFailure, ApplicationFailure, CancelledFailure } from "@temporalio/workflow";
import { expect, test } from "bun:test";
import { runFailureMessage } from "../src/workflows.js";

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
