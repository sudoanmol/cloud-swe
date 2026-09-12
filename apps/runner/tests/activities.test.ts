import { expect, test } from "bun:test";
import { temporalFailure } from "../src/activity-scope.js";
import { ThreadStoreError } from "@cloud-swe/db/thread-contracts";

test("durable demo errors retain their public code across the Temporal boundary", () => {
  const error = temporalFailure(
    new ThreadStoreError("DEMO_EXECUTION_DEADLINE", "internal details"),
    false,
  );

  expect(error).toMatchObject({
    type: "DEMO_EXECUTION_DEADLINE",
    message: "This task reached the demo's 10-minute execution limit.",
  });
});
