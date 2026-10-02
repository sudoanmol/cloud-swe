/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { ThreadApiError, type ReplayPage, type ThreadStreamEvent } from "@cloud-swe/api/client";
import {
  replayPages,
  type ReplayPage as StoredReplayPage,
  type ReplayStore,
} from "@cloud-swe/api/replay";
import { jsonValueSchema, type JsonObject } from "@cloud-swe/db/json";
import { z } from "zod";

import type { ThreadProjection } from "./chat-types";
import { consumeThreadEvents } from "./thread-event-reader";
import { applyReplayPage, applyThreadEvents, emptyProjection } from "./thread-projection";

const threadId = "11111111-1111-4111-8111-111111111111";

const runId = "22222222-2222-4222-8222-222222222222";

type Text = { attemptId?: string; assistantAttempt?: number; messageIndex?: number };

/** Builds a log with consecutive sequences, as PostgreSQL commits them. */
function log(...steps: Array<(sequence: number) => ThreadStreamEvent>): ThreadStreamEvent[] {
  return steps.map((step, index) => step(index + 1));
}

const text = ({ attemptId = "a1", assistantAttempt = 1, messageIndex = 1 }: Text = {}) => ({
  runId,
  attemptId,
  assistantAttempt,
  messageIndex,
});

const of =
  (type: string, payload: ThreadStreamEvent["payload"]) =>
  (sequence: number): ThreadStreamEvent => ({ sequence, type, payload });

const started = (identity: Text = {}) => of("assistant.started", text(identity));

const deltas = (words: string[], identity: Text = {}) =>
  words.map((word, index) =>
    of("assistant.delta", { ...text(identity), deltaIndex: index, delta: word }),
  );

const message = (content: string, identity: Text = {}, extra: JsonObject = {}) =>
  of("assistant.message", { ...text(identity), content, stopReason: "stop", ...extra });

const toolStarted = (toolCallId: string) =>
  of("tool.started", {
    runId,
    attemptId: "a1",
    toolCallId,
    name: "remote_exec",
    args: { command: "echo hi" },
  });

const toolOutput = (toolCallId: string, chunk: string, offset: number) =>
  of("tool.output", {
    runId,
    attemptId: "a1",
    toolCallId,
    incremental: true,
    stream: "stdout",
    offset,
    nextOffset: offset + chunk.length,
    text: chunk,
  });

const toolCompleted = (toolCallId: string) =>
  of("tool.completed", {
    runId,
    attemptId: "a1",
    toolCallId,
    name: "remote_exec",
    output: "hi\n",
    isError: false,
  });

const runEvent = (type: string, extra: JsonObject = {}) => of(type, { runId, ...extra });

const fieldsSchema = z.record(z.string(), jsonValueSchema);

function memoryStore(events: readonly ThreadStreamEvent[]): ReplayStore {
  return {
    listEventIndex: async ({ after, through, limit }) =>
      events
        .flatMap(({ sequence, type, payload }) => {
          if (sequence <= after || sequence > through) return [];

          const fields = fieldsSchema.parse(payload);

          return [
            {
              sequence,
              type,
              runId: fields.runId,
              attemptId: fields.attemptId,
              assistantAttempt: fields.assistantAttempt,
              messageIndex: fields.messageIndex,
              contentTruncated: fields.contentTruncated,
            },
          ];
        })
        .slice(0, limit),
    listEventsAt: async ({ sequences }) =>
      events.flatMap((item) =>
        sequences.includes(item.sequence)
          ? [{ ...item, id: `event-${item.sequence}`, dedupeKey: "", createdAt: new Date(0) }]
          : [],
      ),
  };
}

/** The page as the browser receives it: payloads arrive as JSON. */
function clientPage(page: StoredReplayPage): ReplayPage {
  return {
    after: page.after,
    through: page.through,
    events: page.events.map(({ sequence, type, payload }) => ({
      sequence,
      type,
      payload: jsonValueSchema.parse(payload),
    })),
  };
}

function fullAt(events: readonly ThreadStreamEvent[], through: number): ThreadProjection {
  return applyThreadEvents(
    emptyProjection(threadId),
    events.filter((item) => item.sequence <= through),
  );
}

const scenarios = {
  "text and tool parts keep their order": log(
    runEvent("run.queued"),
    runEvent("run.started"),
    started(),
    ...deltas(["Let ", "me ", "check ", "the ", "tests."]),
    message("Let me check the tests.", {}, { stopReason: "toolUse" }),
    toolStarted("call-1"),
    toolOutput("call-1", "h", 0),
    toolOutput("call-1", "i\n", 1),
    toolCompleted("call-1"),
    started({ messageIndex: 2 }),
    ...deltas(["All ", "tests ", "pass."], { messageIndex: 2 }),
    message("All tests pass.", { messageIndex: 2 }),
    runEvent("run.completed"),
  ),
  "a truncated final keeps the longer streamed text": log(
    started(),
    ...deltas(["abc", "def", "ghi"]),
    message("abc", {}, { contentTruncated: true }),
    runEvent("run.completed"),
  ),
  "a failed run leaves unfinished text partial": log(
    started(),
    ...deltas(["half ", "a "]),
    runEvent("run.failed", { error: "boom" }),
  ),
  "an errored final stays partial": log(
    started(),
    ...deltas(["half ", "a "]),
    message("half a ", {}, { stopReason: "error" }),
    runEvent("run.failed", { error: "boom" }),
  ),
  "a cancelled run keeps what streamed": log(
    started(),
    ...deltas(["one ", "two "]),
    runEvent("run.cancel_requested"),
    runEvent("run.cancelled"),
  ),
  "a replacement attempt drops unfinished text": log(
    started(),
    ...deltas(["first ", "try "]),
    started({ attemptId: "a2", assistantAttempt: 2 }),
    ...deltas(["second ", "try"], { attemptId: "a2", assistantAttempt: 2 }),
    message("second try", { attemptId: "a2", assistantAttempt: 2 }),
    runEvent("run.completed"),
  ),
  "an interleaved event splits a delta run": log(
    started(),
    ...deltas(["a", "b"]),
    of("workspace.running", { threadId, state: "running", generation: 1 }),
    ...deltas(["c", "d"]),
    message("abcd"),
  ),
  "legacy deltas without a message index are kept": log(
    of("assistant.started", { runId, attemptId: "a1", assistantAttempt: 1 }),
    of("assistant.delta", {
      runId,
      attemptId: "a1",
      assistantAttempt: 1,
      deltaIndex: 0,
      delta: "x",
    }),
    of("assistant.delta", {
      runId,
      attemptId: "a1",
      assistantAttempt: 1,
      deltaIndex: 1,
      delta: "y",
    }),
    message("xy"),
  ),
} satisfies Record<string, ThreadStreamEvent[]>;

describe("compacted replay matches a full replay", () => {
  for (const [name, events] of Object.entries(scenarios))
    for (const pageSize of [1, 2, 3, 100])
      test(`${name} (page size ${pageSize})`, async () => {
        const watermark = events.at(-1)?.sequence ?? 0;
        let projection = emptyProjection(threadId);
        let cursor = 0;

        for await (const page of replayPages(memoryStore(events), {
          threadId,
          after: 0,
          through: watermark,
          pageSize,
        })) {
          expect(page.after).toBe(cursor);
          projection = applyReplayPage(projection, clientPage(page));
          cursor = page.through;
          // Every committed cursor is a point where a reconnect may resume.
          expect(projection).toEqual(fullAt(events, cursor));
        }

        expect(cursor).toBe(watermark);
      });

  test("omits the redundant deltas", async () => {
    const events = scenarios["text and tool parts keep their order"];
    let sent = 0;

    for await (const page of replayPages(memoryStore(events), {
      threadId,
      after: 0,
      through: events.length,
      pageSize: 100,
    }))
      sent += page.events.length;

    // Six of the eight deltas are covered by their messages.
    expect(sent).toBe(events.length - 6);
  });

  test("a disconnect during replay resumes to the same projection", async () => {
    const events = scenarios["text and tool parts keep their order"];
    const store = memoryStore(events);
    const abort = new AbortController();
    let projection = emptyProjection(threadId);
    let connections = 0;

    await consumeThreadEvents({
      threadId,
      signal: abort.signal,
      readCursor: () => projection.cursor,
      retryDelay: () => 0,
      onState: () => undefined,
      onEvents: (batch) => {
        projection = applyThreadEvents(projection, batch);
      },
      onReplay: (page) => {
        projection = applyReplayPage(projection, page);
        expect(projection).toEqual(fullAt(events, page.through));

        if (page.through === events.length) abort.abort();
      },
      stream: async (input) => {
        connections += 1;
        input.onOpen?.();
        let pages = 0;

        for await (const page of replayPages(store, {
          threadId,
          after: input.after ?? 0,
          through: events.length,
          pageSize: 2,
        })) {
          input.onReplay(clientPage(page));
          pages += 1;

          if (connections === 1 && pages === 2)
            throw new ThreadApiError(503, "UNAVAILABLE", "Connection dropped");
        }
      },
    });

    expect(connections).toBe(2);
    expect(projection).toEqual(fullAt(events, events.length));
  });

  test("a page that does not start at the applied cursor reconnects", async () => {
    const abort = new AbortController();
    const starts: number[] = [];
    let cursor = 0;

    await consumeThreadEvents({
      threadId,
      signal: abort.signal,
      readCursor: () => cursor,
      retryDelay: () => 0,
      onState: () => undefined,
      onEvents: () => undefined,
      onReplay: (page) => {
        cursor = page.through;
        abort.abort();
      },
      stream: async (input) => {
        starts.push(input.after ?? 0);
        input.onReplay(
          starts.length === 1
            ? { after: 3, through: 5, events: [{ sequence: 5, type: "future.event", payload: {} }] }
            : {
                after: 0,
                through: 2,
                events: [{ sequence: 2, type: "future.event", payload: {} }],
              },
        );
      },
    });

    expect(starts).toEqual([0, 0]);
    expect(cursor).toBe(2);
  });
});
