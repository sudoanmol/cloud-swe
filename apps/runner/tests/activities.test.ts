import { expect, test } from "bun:test";
import { z } from "zod";
import { UnresolvedCommandError } from "../src/execution-coordinator.js";
import { pauseOtherWorkspace, type LifecycleResult } from "../src/activities.js";

const otherWorkspace = { threadId: "thread-other" };

function unknownCommand() {
  return new UnresolvedCommandError({
    workspaceId: "workspace-other",
    generation: 2,
    commandId: "command-1",
    message: "guest status lost",
  });
}

test("an unknown command in another workspace recovers that workspace", async () => {
  const failure = unknownCommand();
  const recovered: Array<{ threadId: string; commandId: string }> = [];
  const reprepare = new Error("reprepare");

  const transition = async (_threadId: string): Promise<LifecycleResult> => {
    throw failure;
  };

  const recover = async (threadId: string, error: UnresolvedCommandError): Promise<never> => {
    recovered.push({ threadId, commandId: error.commandId });
    throw reprepare;
  };

  const error = await pauseOtherWorkspace(transition, recover, otherWorkspace, "run-1").then(
    () => undefined,
    z.instanceof(Error).parse,
  );

  expect(recovered).toEqual([{ threadId: "thread-other", commandId: "command-1" }]);
  expect(error).toBe(reprepare);
});

test("ordinary transition failures do not trigger recovery", async () => {
  let recoveries = 0;
  const failure = new Error("provider timed out");

  const transition = async (_threadId: string): Promise<LifecycleResult> => {
    throw failure;
  };

  const recover = async (): Promise<never> => {
    recoveries += 1;
    throw new Error("must not recover");
  };

  const error = await pauseOtherWorkspace(transition, recover, otherWorkspace, "run-1").then(
    () => undefined,
    z.instanceof(Error).parse,
  );

  expect(error).toBe(failure);
  expect(recoveries).toBe(0);
});

test("a deferred pause blocks the run without recovery", async () => {
  let recoveries = 0;

  const transition = async (): Promise<LifecycleResult> => ({
    outcome: "deferred",
    reason: "active-run",
  });

  const recover = async (): Promise<never> => {
    recoveries += 1;
    throw new Error("must not recover");
  };

  const error = await pauseOtherWorkspace(transition, recover, otherWorkspace, "run-1").then(
    () => undefined,
    z.instanceof(Error).parse,
  );

  expect(error).toBeInstanceOf(Error);

  if (!(error instanceof Error)) throw new Error("Expected a transition error");
  expect(error.message).toContain("run-1");
  expect(recoveries).toBe(0);
});

test("completed and missing pauses resolve", async () => {
  const recover = async (): Promise<never> => {
    throw new Error("must not recover");
  };

  await pauseOtherWorkspace(
    async () => ({ outcome: "completed" }),
    recover,
    otherWorkspace,
    "run-1",
  );
  await pauseOtherWorkspace(async () => ({ outcome: "missing" }), recover, otherWorkspace, "run-1");
});
