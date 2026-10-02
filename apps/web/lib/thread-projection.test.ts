/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { ThreadStreamEvent } from "@cloud-swe/api/client";
import { threadSnapshotSchema } from "@cloud-swe/api/contracts";
import {
  applyThreadEvent,
  applyThreadEvents,
  emptyProjection,
  reconcileThreadSnapshot,
  retainNewestSnapshot,
  staleQueries,
} from "./thread-projection";
import { buildTranscript } from "./thread-transcript";
import { QueryClient } from "@tanstack/react-query";
import { threadProjectionQueryOptions } from "./queries";

const threadId = "11111111-1111-4111-8111-111111111111";

const runId = "22222222-2222-4222-8222-222222222222";

const identity = { runId, attemptId: "z-old", assistantAttempt: 1, messageIndex: 1 };

function event(
  sequence: number,
  type: string,
  payload: ThreadStreamEvent["payload"],
): ThreadStreamEvent {
  return { sequence, type, payload };
}

const start = (sequence: number, overrides: Partial<typeof identity> = {}) =>
  event(sequence, "assistant.started", { ...identity, ...overrides });

const delta = (sequence: number, text: string, overrides: Partial<typeof identity> = {}) =>
  event(sequence, "assistant.delta", {
    ...identity,
    deltaIndex: sequence,
    delta: text,
    ...overrides,
  });

const completed = (sequence: number, text: string, overrides: Partial<typeof identity> = {}) =>
  event(sequence, "assistant.message", {
    ...identity,
    content: text,
    stopReason: "toolUse",
    ...overrides,
  });

const tool = (sequence: number, attemptId = identity.attemptId) =>
  event(sequence, "tool.started", {
    runId,
    attemptId,
    toolCallId: "call",
    name: "remote_exec",
    args: { command: "echo hi" },
  });

function snapshot(latestEventId = 10) {
  return threadSnapshotSchema.parse({
    id: threadId,
    userId: "user",
    title: "Current title",
    repositoryUrl: null,
    repositoryBranch: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    latestEventId,
    messages: [],
    workspace: null,
    runs: [
      {
        id: runId,
        status: "completed",
        prompt: "task",
        modelSelection: null,
        cancelRequestedAt: null,
        approvalWaitStartedAt: null,
        questionWaitStartedAt: null,
        startedAt: null,
        completedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        error: null,
      },
    ],
  });
}

function transcript(projection: ReturnType<typeof emptyProjection>, content?: string) {
  const current = snapshot(projection.cursor);

  if (content !== undefined)
    current.messages.push({
      id: "33333333-3333-4333-8333-333333333333",
      runId,
      role: "assistant",
      content,
      clientMessageId: null,
      createdAt: current.createdAt,
      attachments: [],
    });

  return buildTranscript({
    snapshotRuns: current.runs,
    snapshotMessages: current.messages,
    projection,
    optimistic: [],
    snapshotWatermark: current.latestEventId ?? 0,
  });
}

describe("durable thread replay", () => {
  test("replays historical scripted command events without relaxing malformed Pi events", () => {
    const projection = applyThreadEvents(emptyProjection(threadId), [
      event(1, "assistant.started", { runId, attemptId: "a" }),
      event(2, "tool.started", {
        runId,
        attemptId: "a",
        name: "shell",
        command: "Check the workspace",
      }),
      event(3, "tool.output", {
        runId,
        attemptId: "a",
        kind: "failed",
        output: "stdout",
        stderr: "stderr",
        exitCode: 3,
        outputTruncated: false,
      }),
      event(4, "tool.completed", {
        runId,
        attemptId: "a",
        name: "shell",
        exitCode: 3,
        isError: true,
      }),
      event(5, "assistant.delta", { runId, attemptId: "a", content: "The check failed", delta: 0 }),
      event(6, "run.completed", { runId }),
    ]);

    expect(projection.cursor).toBe(6);
    expect(
      projection.runs
        .find((run) => run.runId === runId)
        ?.parts.find((part) => part.kind === "tool"),
    ).toMatchObject({
      name: "remote_exec",
      state: "failed",
      finalOutput: "stdout\nstderr",
      legacy: { statusCode: 3 },
    });
    expect(() =>
      applyThreadEvents(emptyProjection(threadId), [
        event(1, "tool.started", {
          runId,
          attemptId: "a",
          name: "remote_exec",
          args: { command: "pwd" },
        }),
      ]),
    ).toThrow();
  });

  test("question history retains its durable request identity through answer replay", () => {
    const requestId = "request-1";

    const projection = applyThreadEvents(emptyProjection(threadId), [
      start(1),
      event(2, "questions.requested", {
        runId,
        requestId,
        request: {
          id: requestId,
          toolCallId: "question-call",
          questions: [{ id: "choice", header: "Scope", question: "Which scope?" }],
        },
      }),
      event(3, "questions.answered", { runId, requestId, answers: { choice: "Small" } }),
    ]);

    expect(
      transcript(projection).filter(
        (entry) => entry.kind === "marker" && entry.questionRequestId === requestId,
      ),
    ).toHaveLength(1);
  });

  test("returning to a thread retains its applied cursor only for the same account", async () => {
    const client = new QueryClient();
    const options = threadProjectionQueryOptions("alice", threadId);
    const projected = applyThreadEvent(emptyProjection(threadId), start(1));

    client.setQueryData(options.queryKey, projected);
    expect((await client.ensureQueryData(options)).cursor).toBe(1);
    expect(
      (await client.ensureQueryData(threadProjectionQueryOptions("bob", threadId))).cursor,
    ).toBe(0);
    client.clear();
    expect((await client.ensureQueryData(options)).cursor).toBe(0);
    client.clear();
  });

  test("malformed incremental variants and missing delta text cannot silently advance", () => {
    const projection = applyThreadEvent(emptyProjection(threadId), tool(1));

    expect(() =>
      applyThreadEvent(
        projection,
        event(2, "tool.output", {
          runId,
          attemptId: "z-old",
          toolCallId: "call",
          incremental: true,
          offset: 0,
        }),
      ),
    ).toThrow();
    expect(() =>
      applyThreadEvent(
        projection,
        event(2, "assistant.delta", {
          ...identity,
          deltaIndex: 1,
        }),
      ),
    ).toThrow();
    expect(projection.cursor).toBe(1);
  });

  test("a new assistantAttempt replaces failed partial text without comparing opaque IDs", () => {
    const projection = applyThreadEvents(emptyProjection(threadId), [
      start(1),
      delta(2, "old"),
      start(3, { assistantAttempt: 2 }),
      delta(4, "new", { assistantAttempt: 2 }),
    ]);

    expect(
      projection.runs[0]?.parts.map((part) => (part.kind === "text" ? part.text : part.kind)),
    ).toEqual(["new"]);
  });

  test("bounded boundary event does not cut off a complete streamed message", () => {
    const projection = applyThreadEvents(emptyProjection(threadId), [
      start(1),
      delta(2, "complete text"),
      event(3, "assistant.message", {
        ...identity,
        content: "complete",
        contentTruncated: true,
        stopReason: "stop",
      }),
    ]);

    expect(projection.runs[0]?.parts[0]?.kind === "text" && projection.runs[0].parts[0].text).toBe(
      "complete text",
    );
  });

  test("cold replay starts at zero; duplicates do not apply; gaps and malformed known events do not advance", () => {
    const empty = emptyProjection(threadId);
    expect(empty.cursor).toBe(0);
    const first = applyThreadEvent(empty, start(1));
    expect(applyThreadEvent(first, start(1))).toBe(first);
    expect(() => applyThreadEvent(first, delta(3, "gap"))).toThrow("gap");
    expect(() => applyThreadEvent(first, event(2, "assistant.delta", {}))).toThrow();
    expect(first.cursor).toBe(1);
    expect(applyThreadEvent(first, event(2, "future.event", {})).unsupported).toHaveLength(1);
  });

  test("commentary stays before tools and final snapshot replaces only the last response by run identity", () => {
    const projection = applyThreadEvents(emptyProjection(threadId), [
      start(1),
      delta(2, "Looking"),
      completed(3, "Looking"),
      tool(4),
      start(5, { messageIndex: 2 }),
      delta(6, "Fin", { messageIndex: 2 }),
      event(7, "run.completed", { runId }),
    ]);

    const entries = transcript(projection, "Final persisted answer");
    expect(entries.map((entry) => entry.kind)).toEqual(["assistant", "tool", "assistant"]);
    expect(
      entries.filter((entry) => entry.kind === "assistant").map((entry) => entry.part.text),
    ).toEqual(["Looking", "Final persisted answer"]);
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(entries.length);
  });

  test("legacy deltas after tools start another contiguous text segment", () => {
    const legacy = (sequence: number, text: string) =>
      event(sequence, "assistant.delta", {
        runId,
        attemptId: "a",
        assistantAttempt: 1,
        deltaIndex: sequence,
        delta: text,
      });

    const projection = applyThreadEvents(emptyProjection(threadId), [
      legacy(1, "before"),
      tool(2, "a"),
      legacy(3, "after"),
      legacy(4, "!"),
    ]);

    expect(
      projection.runs[0]?.parts.map((part) => (part.kind === "text" ? part.text : part.kind)),
    ).toEqual(["before", "tool", "after!"]);
  });

  test("opaque attempt arrival replaces only incomplete material, not committed question commentary", () => {
    const projection = applyThreadEvents(emptyProjection(threadId), [
      start(1),
      completed(2, "Question context"),
      start(3, { messageIndex: 2 }),
      delta(4, "failed partial", { messageIndex: 2 }),
      tool(5),
      start(6, { attemptId: "a-new" }),
      delta(7, "continued", { attemptId: "a-new" }),
    ]);

    expect(
      projection.runs[0]?.parts.map((part) => (part.kind === "text" ? part.text : part.kind)),
    ).toEqual(["Question context", "continued"]);
  });

  test("assistantAttempt and attemptId both participate in identity; call IDs may repeat on a new attempt", () => {
    const projection = applyThreadEvents(emptyProjection(threadId), [
      start(1),
      completed(2, "one"),
      tool(3),
      event(4, "tool.completed", {
        runId,
        attemptId: "z-old",
        toolCallId: "call",
        kind: "completed",
      }),
      start(5, { assistantAttempt: 2 }),
      completed(6, "two", { assistantAttempt: 2 }),
      start(7, { attemptId: "a-new" }),
      tool(8, "a-new"),
    ]);

    const parts = projection.runs[0]?.parts ?? [];
    expect(parts.filter((part) => part.kind === "tool")).toHaveLength(2);
    expect(new Set(parts.map((part) => part.key)).size).toBe(parts.length);
  });

  test("failed/cancelled snapshots retain partial text even if terminal event is not replayed yet", () => {
    const projection = applyThreadEvents(emptyProjection(threadId), [
      start(1),
      delta(2, "partial"),
    ]);

    const current = snapshot(9);
    current.runs = current.runs.map((run) => ({ ...run, status: "failed" }));

    const entries = buildTranscript({
      snapshotRuns: current.runs,
      snapshotMessages: [],
      projection,
      optimistic: [],
      snapshotWatermark: 9,
    });

    expect(entries[0]?.kind === "assistant" && entries[0].part.state).toBe("partial");
  });

  test("split UTF-8 byte ranges dedupe separately from SSE sequence, final output replaces preview", () => {
    const chunk = (sequence: number, offset: number, nextOffset: number, text: string) =>
      event(sequence, "tool.output", {
        runId,
        attemptId: "z-old",
        toolCallId: "call",
        incremental: true,
        stream: "stdout",
        offset,
        nextOffset,
        bytes: nextOffset - offset,
        text,
      });

    let projection = applyThreadEvents(emptyProjection(threadId), [
      tool(1),
      chunk(2, 0, 1, ""),
      chunk(3, 1, 3, "€"),
      chunk(4, 1, 3, "€"),
    ]);

    expect(
      projection.runs[0]?.parts[0]?.kind === "tool" && projection.runs[0].parts[0].live.stdout,
    ).toBe("€");
    projection = applyThreadEvent(
      projection,
      event(5, "tool.completed", {
        runId,
        attemptId: "z-old",
        toolCallId: "call",
        kind: "completed",
        output: "€ done",
        stdout: "€ done",
        stderr: "",
        statusCode: 0,
      }),
    );
    const part = projection.runs[0]?.parts[0];
    expect(part?.kind === "tool" && part.finalOutput).toBe("€ done");
    expect(part?.kind === "tool" && part.live.stdout).toBe("");
  });

  test("nonzero exit is a failed tool even if Pi isError is false", () => {
    const projection = applyThreadEvents(emptyProjection(threadId), [
      tool(1),
      event(2, "tool.completed", {
        runId,
        attemptId: "z-old",
        toolCallId: "call",
        isError: false,
        kind: "nonzero",
        statusCode: 1,
      }),
    ]);

    expect(projection.runs[0]?.parts[0]?.kind === "tool" && projection.runs[0].parts[0].state).toBe(
      "failed",
    );
  });

  test("cold replay cannot regress snapshot summary; newer events beat stale refetches", () => {
    const newer = snapshot(3);

    let projection = applyThreadEvents(emptyProjection(threadId), [
      event(1, "run.started", { runId }),
      event(2, "thread.title.updated", { title: "Old" }),
    ]);

    expect(reconcileThreadSnapshot(newer, projection).runs[0]?.status).toBe("completed");
    expect(reconcileThreadSnapshot(newer, projection).title).toBe("Current title");
    projection = applyThreadEvents(projection, [
      event(3, "run.completed", { runId }),
      event(4, "thread.title.updated", { title: "Newest" }),
    ]);
    expect(reconcileThreadSnapshot(newer, projection).title).toBe("Newest");
    expect(retainNewestSnapshot(newer, snapshot(1))).toBe(newer);
  });

  test("optimistic accepted prompt precedes events even before snapshot contains its run", () => {
    const projection = applyThreadEvents(emptyProjection(threadId), [start(1), delta(2, "reply")]);

    const entries = buildTranscript({
      snapshotRuns: [],
      snapshotMessages: [],
      projection,
      optimistic: [{ threadId, runId, clientMessageId: "m", text: "prompt", attachments: [] }],
    });

    expect(entries.map((entry) => entry.kind)).toEqual(["user", "assistant"]);
  });
});

test("a question event refreshes the question list even when the snapshot covers it", () => {
  const events = [{ sequence: 5, type: "questions.requested" }];

  expect(staleQueries(events, 5)).toEqual({ snapshot: false, questions: true });
  expect(staleQueries(events, 4)).toEqual({ snapshot: true, questions: true });
  expect(staleQueries([{ sequence: 6, type: "assistant.delta" }], 5)).toEqual({
    snapshot: false,
    questions: false,
  });
});
