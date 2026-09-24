/// <reference types="bun" />
import { expect, test } from "bun:test";
import { ThreadApiError, type ThreadStreamEvent } from "@cloud-swe/api/client";
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
