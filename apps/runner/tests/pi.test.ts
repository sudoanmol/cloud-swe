import { expect, test } from "bun:test";
import {
  assistantDeltaDedupeKey,
  assistantStartedDedupeKey,
  assertPiCheckpointSize,
  buildRemoteWriteCommand,
  commandOutput,
  createPiResourceLoader,
  normalizePiCommandResult,
  PI_TOOL_NAMES,
  piAttemptEventIdentity,
  PiCheckpointLimitError,
  serializedPiCheckpointBytes,
  workspacePath,
  type PiSessionMetadata,
} from "../src/pi.js";
import { OrderedPiWriter } from "../src/pi-writer.js";
import { processResult, transportResult } from "../src/sandbox.js";

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

  const first = writer.write(async () => {
    order.push("first-start");
    await firstDone;
    order.push("first-end");
  });
  const second = writer.write(async () => {
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

  const first = writer.write(async () => {
    executed.push("first");
    throw failure;
  });
  const later = writer.write(async () => {
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
  expect(result.outcome).toBe("nonzero");
  expect(result.statusCode).toBe(7);
  expect(result.stdout).toContain("stdout");
  expect(result.stderr).toContain("stderr");
  expect(result.diagnostic).toContain("exit code 7");
  expect(commandOutput(processResult("output", "", 1), 128)).toContain("exit code 1");
});

test("output limits mark truncation without dropping the result contract", () => {
  const result = normalizePiCommandResult(processResult("abcdefgh", "ijkl", 1), 5);
  expect(result.kind).toBe("output-limit");
  expect(result.statusCode).toBe(1);
  expect(result.outputTruncated).toBe(true);
  expect(result.truncated).toBe(true);
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
