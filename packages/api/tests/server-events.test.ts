import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";

import type { ThreadEvent } from "@cloud-swe/db/thread-contracts";
import {
  consumeThreadEventStream,
  threadEventStream,
  writeFrame,
  type EventSocket,
  type EventStreamItem,
} from "../src/server-events";

function event(sequence: number): ThreadEvent {
  return {
    id: `event-${sequence}`,
    sequence,
    type: "run.queued",
    payload: {},
    dedupeKey: `event-${sequence}`,
    createdAt: new Date(0),
  };
}

function memoryStore(events: ThreadEvent[], onPoll: () => void = () => undefined) {
  return {
    listEvents: async ({ after = 0 }: { after?: number }) => {
      onPoll();

      return events.filter((item) => item.sequence > after);
    },
    listEventIndex: async ({ after, through }: { after: number; through: number }) =>
      events.flatMap(({ sequence, type }) =>
        sequence > after && sequence <= through
          ? [
              {
                sequence,
                type,
                runId: undefined,
                attemptId: undefined,
                assistantAttempt: undefined,
                messageIndex: undefined,
                contentTruncated: undefined,
              },
            ]
          : [],
      ),
    listEventsAt: async ({ sequences }: { sequences: readonly number[] }) =>
      events.filter((item) => sequences.includes(item.sequence)),
  };
}

function replayed(item: EventStreamItem | undefined) {
  return item?.kind === "replay"
    ? {
        after: item.page.after,
        through: item.page.through,
        sequences: item.page.events.map((value) => value.sequence),
      }
    : null;
}

describe("server event stream", () => {
  test("replays history up to the watermark before polling the tail", async () => {
    let polls = 0;

    const stream = threadEventStream({
      store: memoryStore([event(1), event(2), event(3)], () => {
        polls += 1;
      }),
      threadId: "thread-1",
      after: 0,
      watermark: 2,
      pollMs: 1,
      heartbeatMs: 60_000,
    });

    const items = await Effect.runPromise(Stream.runCollect(Stream.take(stream, 2)));

    expect(replayed(items[0])).toEqual({ after: 0, through: 2, sequences: [1, 2] });
    expect(items[1]?.kind === "event" ? items[1].event.sequence : -1).toBe(3);
    expect(polls).toBe(1);
  });

  test("uses TestClock for bounded polling and heartbeats", async () => {
    let polls = 0;

    const stream = threadEventStream({
      store: memoryStore([], () => {
        polls += 1;
      }),
      threadId: "thread-1",
      after: 0,
      watermark: 0,
      pollMs: 100,
      heartbeatMs: 1_000,
    });

    const program = Effect.gen(function* () {
      const fiber = yield* Stream.runCollect(Stream.take(stream, 1)).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(1_000);

      return yield* Fiber.join(fiber);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer()));

    const items = await Effect.runPromise(program);

    expect(items).toEqual([{ kind: "heartbeat" }]);
    expect(polls).toBeGreaterThan(0);
  });

  test("allocates cursor state independently for each consumer", async () => {
    const stream = threadEventStream({
      store: memoryStore([event(1), event(2)]),
      threadId: "thread-1",
      after: 0,
      watermark: 2,
      pollMs: 1,
      heartbeatMs: 60_000,
    });

    const [first, second] = await Promise.all([
      Effect.runPromise(Stream.runCollect(Stream.take(stream, 1))),
      Effect.runPromise(Stream.runCollect(Stream.take(stream, 1))),
    ]);

    expect(replayed(first[0])).toEqual({ after: 0, through: 2, sequences: [1, 2] });
    expect(replayed(second[0])).toEqual({ after: 0, through: 2, sequences: [1, 2] });
  });

  test("does not fetch another page while a writer is blocked", async () => {
    let release!: () => void;
    let started!: () => void;

    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const writeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });

    let polls = 0;
    const controller = new AbortController();

    const running = consumeThreadEventStream(
      {
        store: memoryStore([event(1)], () => {
          polls += 1;
        }),
        threadId: "thread-1",
        after: 0,
        watermark: 1,
        pollMs: 1,
        heartbeatMs: 60_000,
      },
      async () => {
        started();
        await blocked;
        controller.abort();
      },
      controller.signal,
    );

    await writeStarted;
    expect(polls).toBe(0);
    release();
    await running.catch(() => undefined);
    expect(polls).toBe(0);
  });

  test("removes drain listeners when the socket closes", async () => {
    class FakeSocket extends EventEmitter implements EventSocket {
      destroyed = false;
      writableEnded = false;
      frames: string[] = [];

      write(frame: string): boolean {
        this.frames.push(frame);

        return false;
      }

      once(event: "drain" | "close" | "error", listener: () => void): this {
        return super.once(event, listener);
      }

      off(event: "drain" | "close" | "error", listener: () => void): this {
        return super.off(event, listener);
      }
    }

    const socket = new FakeSocket();
    const pending = writeFrame(socket, "event\n\n");

    expect(socket.listenerCount("drain")).toBe(1);
    expect(socket.listenerCount("close")).toBe(1);
    expect(socket.listenerCount("error")).toBe(1);
    socket.emit("close");
    await pending;
    expect(socket.listenerCount("drain")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
    expect(socket.listenerCount("error")).toBe(0);
  });

  test("rejects and removes listeners when the socket errors", async () => {
    class FakeSocket extends EventEmitter implements EventSocket {
      destroyed = false;
      writableEnded = false;

      write(): boolean {
        return false;
      }

      once(event: "drain" | "close" | "error", listener: () => void): this {
        return super.once(event, listener);
      }

      off(event: "drain" | "close" | "error", listener: () => void): this {
        return super.off(event, listener);
      }
    }

    const socket = new FakeSocket();
    const pending = writeFrame(socket, "event\n\n");

    socket.emit("error");
    await expect(pending).rejects.toThrow("SSE socket failed");
    expect(socket.listenerCount("drain")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
    expect(socket.listenerCount("error")).toBe(0);
  });
});
