/// <reference types="bun" />
import { expect, spyOn, test } from "bun:test";
import {
  SSE_MAX_BUFFER_BYTES,
  ThreadApiError,
  createApiTransport,
  type ThreadStreamEvent,
} from "@cloud-swe/api/client";
import { consumeThreadEvents, type ThreadEventSource } from "./thread-event-reader";

function event(sequence: number): ThreadStreamEvent {
  return { sequence, type: "future.event", payload: {} };
}

test("gap reconnects from applied cursor, drops duplicates and preserves accepted prior events", async () => {
  const abort = new AbortController();
  let cursor = 0;
  const starts: number[] = [];
  const applied: number[] = [];
  await consumeThreadEvents({
    threadId: "t",
    signal: abort.signal,
    readCursor: () => cursor,
    retryDelay: () => 0,
    onState: () => undefined,
    onEvents: (events, next) => {
      applied.push(...events.map((value) => value.sequence));
      cursor = next;

      if (cursor === 2) abort.abort();
    },
    stream: async (input) => {
      starts.push(input.after ?? 0);
      input.onOpen?.();

      if (starts.length === 1) {
        input.onEvent(event(1));
        input.onEvent(event(3));
      } else {
        input.onEvent(event(1));
        input.onEvent(event(2));
      }
    },
  });
  expect(starts).toEqual([0, 1]);
  expect(applied).toEqual([1, 2]);
});

test("malformed known payload stops rather than retrying forever; cursor advances only through valid events", async () => {
  let calls = 0;
  let cursor = 0;
  const states: ThreadEventSource[] = [];
  await consumeThreadEvents({
    threadId: "t",
    signal: new AbortController().signal,
    readCursor: () => cursor,
    onEvents: (_events, next) => {
      cursor = next;
    },
    onState: (state) => states.push(state),
    stream: async (input) => {
      calls += 1;
      input.onEvent(event(1));
      input.onEvent({ sequence: 2, type: "run.started", payload: {} });
    },
  });
  expect(cursor).toBe(1);
  expect(calls).toBe(1);
  expect(states.at(-1)?.error?.code).toBe("PROTOCOL_ERROR");
});

test("idle stream is live after headers and clean EOF has growing bounded backoff", async () => {
  const abort = new AbortController();
  const attempts: number[] = [];
  const states: ThreadEventSource[] = [];
  let connected = 0;
  await consumeThreadEvents({
    threadId: "t",
    signal: abort.signal,
    readCursor: () => 0,
    onEvents: () => undefined,
    onConnected: () => {
      connected += 1;
    },
    onState: (state) => states.push(state),
    retryDelay: (attempt) => {
      attempts.push(attempt);

      if (attempt === 2) abort.abort();

      return 0;
    },
    stream: async (input) => {
      input.onOpen?.();
    },
  });
  expect(attempts).toEqual([0, 1, 2]);
  expect(connected).toBe(3);
  expect(states.filter((state) => state.status === "live")).toHaveLength(3);
});

test("Retry-After is honored and unmount interrupts delay without another request", async () => {
  const abort = new AbortController();
  let calls = 0;
  const delays: Array<number | null> = [];
  await consumeThreadEvents({
    threadId: "t",
    signal: abort.signal,
    readCursor: () => 0,
    onEvents: () => undefined,
    onState: (state) => {
      if (state.status === "reconnecting") {
        delays.push(state.retryInMs);
        abort.abort();
      }
    },
    stream: async () => {
      calls += 1;
      throw new ThreadApiError(429, "SSE_LIMIT", "busy", 30_000);
    },
  });
  expect(calls).toBe(1);
  expect(delays).toEqual([30_000]);
});

test("401 and 404 stop; late events after unmount never reach projection", async () => {
  for (const status of [401, 404]) {
    let calls = 0;
    await consumeThreadEvents({
      threadId: "t",
      signal: new AbortController().signal,
      readCursor: () => 0,
      onEvents: () => undefined,
      onState: () => undefined,
      stream: async () => {
        calls += 1;
        throw new ThreadApiError(status, "DENIED", "denied");
      },
    });
    expect(calls).toBe(1);
  }

  const abort = new AbortController();
  let writes = 0;
  await consumeThreadEvents({
    threadId: "t",
    signal: abort.signal,
    readCursor: () => 0,
    onEvents: () => {
      writes += 1;
    },
    onState: () => undefined,
    stream: async (input) => {
      input.onEvent(event(1));
      abort.abort();
      input.onEvent(event(2));
    },
  });
  expect(writes).toBe(0);
});

test("a large replay read cut mid-frame reconnects from the applied cursor to the same events", async () => {
  const history = Array.from({ length: 400 }, (_, index) => ({
    sequence: index + 1,
    type: "future.event",
    payload: { text: "é✓".padEnd(4_000, "x") },
  }));

  const frames = (after: number) =>
    new TextEncoder().encode(
      history
        .filter((item) => item.sequence > after)
        .map(
          (item) =>
            `id: ${item.sequence}\nevent: ${item.type}\ndata: ${JSON.stringify(item.payload)}\n\n`,
        )
        .join(""),
    );

  const starts: number[] = [];

  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (url: string | URL | Request) => {
        const after = Number(new URL(String(url)).searchParams.get("after"));
        starts.push(after);
        const body = frames(after);
        // The first connection drops after a single read larger than the frame limit.
        const sent = starts.length === 1 ? body.subarray(0, Math.floor(body.length * 0.7)) : body;

        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(sent);
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  const abort = new AbortController();
  const applied: ThreadStreamEvent[] = [];
  const states: ThreadEventSource["status"][] = [];
  let cursor = 0;

  try {
    expect(frames(0).length * 0.7).toBeGreaterThan(SSE_MAX_BUFFER_BYTES);
    await consumeThreadEvents({
      threadId: "t",
      signal: abort.signal,
      stream: createApiTransport({ baseUrl: "http://test" }).streamEvents,
      readCursor: () => cursor,
      retryDelay: () => 0,
      onState: (state) => states.push(state.status),
      onEvents: (events, next) => {
        applied.push(...events);
        cursor = next;

        if (cursor === history.length) abort.abort();
      },
    });
  } finally {
    fetch.mockRestore();
  }

  expect(applied).toEqual(history);
  expect(starts).toHaveLength(2);
  expect(starts[1]).toBeGreaterThan(0);
  expect(states).not.toContain("stopped");
});
