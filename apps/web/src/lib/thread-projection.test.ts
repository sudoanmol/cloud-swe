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
    name: "bash",
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
        manual: false,
      },
    ],
  });
}

test("steered messages replay at consumption position once and survive attempt replacement", () => {
  const messageId = "44444444-4444-4444-8444-444444444444";

  const steer = event(4, "message.steered", {
    runId,
    attemptId: identity.attemptId,
    messageId,
    entryId: "entry",
    content: "change course",
    clientMessageId: "client",
    attachments: [],
  });

  const projection = applyThreadEvents(emptyProjection(threadId), [
    start(1),
    delta(2, "before"),
    completed(3, "before"),
    steer,
    start(5, { attemptId: "retry", assistantAttempt: 2 }),
    delta(6, "after", { attemptId: "retry", assistantAttempt: 2 }),
  ]);

  expect(applyThreadEvent(projection, steer)).toEqual(projection);
  const current = snapshot(6);
  current.messages.push({
    id: messageId,
    runId,
    role: "user",
    content: "change course",
    clientMessageId: "client",
    createdAt: current.createdAt,
    attachments: [],
    steered: true,
  });

  const entries = buildTranscript({
    snapshotRuns: current.runs,
    snapshotMessages: current.messages,
    snapshotWatermark: 6,
    projection,
    optimistic: [],
  });

  expect(entries.filter((entry) => entry.kind === "user")).toHaveLength(1);
  expect(
    entries.map((entry) =>
      entry.kind === "assistant"
        ? entry.part.text
        : entry.kind === "user"
          ? entry.text
          : entry.kind,
    ),
  ).toEqual(["before", "change course", "after"]);
});

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
      name: "bash",
      state: "failed",
      finalOutput: "stdout\nstderr",
      legacy: { statusCode: 3 },
    });
    expect(() =>
      applyThreadEvents(emptyProjection(threadId), [
        event(1, "tool.started", {
          runId,
          attemptId: "a",
          name: "bash",
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

test("reasoning streams onto its message and survives the final message", () => {
  const reasoning = (sequence: number, text: string) =>
    event(sequence, "assistant.reasoning.delta", {
      ...identity,
      deltaIndex: sequence,
      delta: text,
    });

  const streamed = applyThreadEvents(emptyProjection(threadId), [
    start(1),
    reasoning(2, "**Plan**"),
    reasoning(3, " read files"),
  ]);

  expect(streamed.runs[0]?.parts[0]).toMatchObject({
    kind: "text",
    text: "",
    reasoning: "**Plan** read files",
    state: "streaming",
  });

  const final = applyThreadEvent(
    streamed,
    event(4, "assistant.message", {
      ...identity,
      content: "",
      stopReason: "toolUse",
      reasoning: "**Plan** read files",
    }),
  );

  expect(final.runs[0]?.parts[0]).toMatchObject({
    reasoning: "**Plan** read files",
    state: "final",
  });

  const replayed = applyThreadEvents(emptyProjection(threadId), [
    start(1),
    event(2, "assistant.message", {
      ...identity,
      content: "",
      stopReason: "toolUse",
      reasoning: "**Plan**",
    }),
  ]);

  expect(replayed.runs[0]?.parts[0]).toMatchObject({ reasoning: "**Plan**" });
});

test("the live diff count follows the latest event and clears on a workspace reset", () => {
  const counted = applyThreadEvents(emptyProjection(threadId), [
    event(1, "diff.updated", { runId, files: 1, additions: 2, deletions: 0 }),
    event(2, "diff.updated", { runId, files: 3, additions: 9, deletions: 4 }),
  ]);

  expect(counted.diffStat).toEqual({
    files: 3,
    additions: 9,
    deletions: 4,
    branch: null,
    head: null,
    dirty: false,
  });

  const reset = applyThreadEvent(
    counted,
    event(3, "workspace.reset", {
      threadId,
      workspaceId: "workspace",
      oldGeneration: 1,
      newGeneration: 2,
      reason: "lost",
      message: "Workspace was replaced.",
    }),
  );

  expect(reset.diffStat).toBeNull();
});

test("workspace replacement preserves user browser ownership until handback", () => {
  const projection = applyThreadEvents(emptyProjection(threadId), [
    event(1, "browser.owner_changed", { owner: "user" }),
    event(2, "workspace.reset", {
      threadId,
      workspaceId: "workspace",
      oldGeneration: 1,
      newGeneration: 2,
      reason: "lost",
      message: "Workspace was replaced.",
    }),
  ]);

  expect(projection.browser.owner).toBe("user");
  expect(
    applyThreadEvent(projection, event(3, "browser.owner_changed", { owner: "agent" })).browser
      .owner,
  ).toBe("agent");
});

test("only mutating tool completions advance the edit sequence", () => {
  const tool = (sequence: number, name: string) =>
    event(sequence, "tool.completed", {
      runId,
      attemptId: "a",
      toolCallId: `call-${sequence}`,
      name,
      isError: false,
    });

  const projection = applyThreadEvents(emptyProjection(threadId), [
    tool(1, "edit"),
    tool(2, "read"),
  ]);

  expect(projection.editSequence).toBe(1);
  expect(applyThreadEvent(projection, tool(3, "bash")).editSequence).toBe(3);
});

test("usage sums every call and the context is the latest call's tokens", () => {
  const call = (input: number, cacheRead: number) => ({
    input,
    output: 10,
    cacheRead,
    cacheWrite: 5,
    cost: 0.25,
  });

  const projection = applyThreadEvents(emptyProjection(threadId), [
    event(1, "assistant.message", { ...identity, content: "one", usage: call(100, 0) }),
    event(2, "assistant.message", {
      ...identity,
      messageIndex: 2,
      content: "two",
      usage: call(20, 100),
    }),
  ]);

  expect(projection.usage).toEqual({
    input: 120,
    output: 20,
    cacheRead: 100,
    cacheWrite: 10,
    cost: 0.5,
    contextTokens: 135,
  });
});

test("browser events replay activity and ownership without unsupported markers", () => {
  const initial = emptyProjection(threadId);
  const driving = applyThreadEvent(initial, event(1, "browser.activity_started", {}));
  const handoff = applyThreadEvent(driving, event(2, "browser.owner_changed", { owner: "user" }));
  const quiet = applyThreadEvent(handoff, event(3, "browser.activity_stopped", {}));
  expect(initial.browser).toEqual({ owner: "agent", active: false });
  expect(driving.browser).toEqual({ owner: "agent", active: true });
  expect(handoff.browser).toEqual({ owner: "user", active: true });
  expect(quiet.browser).toEqual({ owner: "user", active: false });
  expect(quiet.unsupported).toEqual([]);
  expect(applyThreadEvent(quiet, event(3, "browser.owner_changed", { owner: "agent" }))).toBe(
    quiet,
  );
});

test("compaction replay preserves transcript history and reduces the context meter", () => {
  const identity = { runId: "run-1", attemptId: "attempt", assistantAttempt: 1, messageIndex: 1 };

  const events = [
    event(1, "assistant.message", {
      ...identity,
      content: "Earlier answer",
      usage: { input: 30_000, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.1 },
    }),
    event(2, "context.compacted", {
      runId: "run-1",
      attemptId: "attempt",
      entryId: "compact-1",
      reason: "threshold",
      tokensBefore: 30_100,
      contextTokens: 1000,
    }),
  ];

  let projection = emptyProjection("thread-1");

  for (const item of events) projection = applyThreadEvent(projection, item);
  expect(projection.usage?.contextTokens).toBe(1000);
  expect(projection.usage?.input).toBe(30_000);
  expect(projection.runs[0]?.parts).toMatchObject([
    { text: "Earlier answer" },
    { kind: "marker", text: "Context compacted" },
  ]);
  const last = events[1];

  if (!last) throw new Error("Missing compaction event");
  expect(applyThreadEvent(projection, last)).toEqual(projection);
});

test("header Git runs never render as turns, from the snapshot or from live events", () => {
  const manualRunId = "55555555-5555-4555-8555-555555555555";
  const current = snapshot(0);

  const prompt = (id: string, run: string) => ({
    id,
    runId: run,
    role: "user" as const,
    content: id === "66666666-6666-4666-8666-666666666666" ? "Check push" : "Open pull request",
    clientMessageId: null,
    createdAt: current.createdAt,
    attachments: [],
  });

  current.runs[0] = { ...current.runs[0]!, manual: true };
  current.messages.push(prompt("66666666-6666-4666-8666-666666666666", runId));
  current.messages.push(prompt("77777777-7777-4777-8777-777777777777", manualRunId));

  // The second run is only known from its queued event, as during a live check.
  const projection = applyThreadEvents(emptyProjection(threadId), [
    event(1, "run.queued", { runId: manualRunId, manual: true }),
  ]);

  expect(
    buildTranscript({
      snapshotRuns: current.runs,
      snapshotMessages: current.messages,
      projection,
      optimistic: [],
    }),
  ).toEqual([]);
});
