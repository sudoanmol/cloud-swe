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

describe("server event stream", () => {
  test("emits the replay page in order before polling", async () => {
    let polls = 0;

    const stream = threadEventStream({
      store: {
        listEvents: async () => {
          polls += 1;

          return [];
        },
      },
      threadId: "thread-1",
      after: 0,
      initialBatch: [event(1), event(2)],
      pollMs: 1,
      heartbeatMs: 60_000,
    });

    const items = await Effect.runPromise(Stream.runCollect(Stream.take(stream, 2)));

    expect(items.map((item) => (item.kind === "event" ? item.event.sequence : -1))).toEqual([1, 2]);
    expect(polls).toBe(0);
  });

  test("uses TestClock for bounded polling and heartbeats", async () => {
    let polls = 0;

    const stream = threadEventStream({
      store: {
        listEvents: async () => {
          polls += 1;

          return [];
        },
      },
      threadId: "thread-1",
      after: 0,
      initialBatch: [],
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
      store: { listEvents: async () => [] },
      threadId: "thread-1",
      after: 0,
      initialBatch: [event(1), event(2)],
      pollMs: 1,
      heartbeatMs: 60_000,
    });

    const [first, second] = await Promise.all([
      Effect.runPromise(Stream.runCollect(Stream.take(stream, 1))),
      Effect.runPromise(Stream.runCollect(Stream.take(stream, 1))),
    ]);

    expect(first[0]?.kind === "event" ? first[0].event.sequence : -1).toBe(1);
    expect(second[0]?.kind === "event" ? second[0].event.sequence : -1).toBe(1);
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
        store: {
          listEvents: async () => {
            polls += 1;

            return [];
          },
        },
        threadId: "thread-1",
        after: 0,
        initialBatch: [event(1)],
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
