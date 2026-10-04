/// <reference types="bun" />
import { expect, test } from "bun:test";
import type { ProjectedToolPart, TranscriptEntry } from "./chat-types";
import { commandOutput, groupTranscript, safeWebUrl } from "./tool-presentation";

function tool(
  key: string,
  overrides: Partial<ProjectedToolPart> = {},
  runId = "run",
): Extract<TranscriptEntry, { kind: "tool" }> {
  return {
    kind: "tool",
    key,
    runId,
    part: {
      kind: "tool",
      key,
      toolCallId: key,
      attemptId: "attempt",
      name: "read",
      state: "completed",
      args: { path: "file.ts" },
      structured: null,
      legacy: null,
      live: { stdout: "", stderr: "", truncated: false },
      nextOffset: { stdout: 0, stderr: 0 },
      finalOutput: null,
      diagnostic: null,
      ...overrides,
    },
  };
}

test("adjacent tools group without losing calls, changing first identity, or crossing boundaries", () => {
  const first = tool("first");
  const second = tool("second");

  const marker: TranscriptEntry = {
    kind: "marker",
    key: "wait",
    text: "Waiting for input",
    tone: "info",
  };

  const failed = tool("failed", { state: "failed" });

  const groups = groupTranscript([
    first,
    second,
    marker,
    tool("third"),
    tool("attempt2", { attemptId: "different" }),
    tool("run2", {}, "other-run"),
    failed,
    tool("last"),
  ]);

  expect(groups).toHaveLength(7);
  expect(groups[0]).toMatchObject({
    kind: "tool-group",
    key: "first",
    label: "Exploring",
    parts: [first.part, second.part],
  });
  expect(groupTranscript([first])[0]?.key).toBe(groups[0]?.key);
  expect(groups[5]).toEqual(failed);
  expect(first.part.key).toBe("first");
});

test("assistant text closes a group and shell classification excludes compound syntax", () => {
  const assistant: TranscriptEntry = {
    kind: "assistant",
    key: "text",
    part: {
      kind: "text",
      key: "text",
      identity: { attemptId: "attempt", assistantAttempt: 1, messageIndex: 1 },
      legacy: false,
      text: "Checking next",
      state: "final",
      truncated: false,
    },
  };

  expect(groupTranscript([tool("a"), assistant, tool("b")])).toHaveLength(3);

  for (const command of ["ls -la src", "pwd", "rg -n TODO src"]) {
    expect(groupTranscript([tool(command, { name: "bash", args: { command } })])[0]).toMatchObject({
      label: "Exploring",
    });
  }

  for (const command of [
    "ls; rm file",
    "cat $(curl example.com)",
    "ls | sh",
    "ls > file",
    "git status",
    "ls\nrm file",
  ]) {
    expect(groupTranscript([tool(command, { name: "bash", args: { command } })])[0]).toMatchObject({
      label: "Bash commands",
    });
  }
});

test("reconciled output replaces live preview and does not duplicate combined output", () => {
  const part = tool("exec", {
    name: "bash",
    live: { stdout: "old", stderr: "", truncated: true },
    finalOutput: "hello\nwarning",
    legacy: {
      kind: "nonzero",
      stdout: "hello",
      stderr: "warning",
      output: "hello\nwarning",
      statusCode: 1,
      diagnostic: null,
      outputTruncated: false,
    },
  }).part;

  expect(commandOutput(part)).toEqual({ text: "hello\nwarning", truncated: false });
  expect(commandOutput({ ...part, legacy: null })).toEqual({
    text: "hello\nwarning",
    truncated: false,
  });
  expect(commandOutput({ ...part, legacy: null, finalOutput: null })).toEqual({
    text: "old",
    truncated: true,
  });
});

test("web links accept only absolute credential-free HTTP(S) URLs", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///etc/passwd",
    "//example.com",
    "/api/auth",
    "https://user:password@example.com",
    "https://",
    "jav\nascript:alert(1)",
  ])
    expect(safeWebUrl(url)).toBeUndefined();
  expect(safeWebUrl("HTTPS://example.com/path?q=1")).toBe("https://example.com/path?q=1");
});
