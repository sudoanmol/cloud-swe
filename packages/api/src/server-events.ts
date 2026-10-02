import { Clock, Effect, Stream } from "effect";
import type { ThreadEvent } from "@cloud-swe/db/thread-contracts";

import { replayPages, type ReplayPage, type ReplayStore } from "./replay";

export type EventStreamStore = ReplayStore & {
  listEvents(input: { threadId: string; after?: number; limit?: number }): Promise<ThreadEvent[]>;
};

export type EventStreamItem =
  | { readonly kind: "replay"; readonly page: ReplayPage }
  | { readonly kind: "event"; readonly event: ThreadEvent }
  | { readonly kind: "heartbeat" };

export type EventStreamOptions = {
  store: EventStreamStore;
  threadId: string;
  after: number;
  /** Committed event sequence when the reader connected; replay covers up to it. */
  watermark: number;
  pollMs: number;
  heartbeatMs: number;
};

const pageSize = 100;

function one<T>(value: T): [T] {
  return [value];
}

/**
 * Replay committed history in compacted pages up to the connection watermark,
 * then tail new events one at a time. Stream.runForEach invokes the writer for
 * each item before pulling again, so a slow socket also pauses reads.
 */
export function threadEventStream(
  options: EventStreamOptions,
): Stream.Stream<EventStreamItem, unknown> {
  const pollMs = Math.max(1, Math.floor(options.pollMs));
  const heartbeatMs = Math.max(1, Math.floor(options.heartbeatMs));

  return Stream.fromPull<EventStreamItem, unknown, never, never, never>(
    Effect.sync(() => {
      const replay =
        options.after < options.watermark
          ? replayPages(options.store, {
              threadId: options.threadId,
              after: options.after,
              through: options.watermark,
              pageSize,
            })
          : null;

      let replaying = replay !== null;
      let batch: ThreadEvent[] = [];
      let batchIndex = 0;
      let lastSequence = Math.max(options.after, options.watermark);
      // The tail's first read follows replay without waiting.
      let fetchNow = true;
      let lastHeartbeatAt: number | undefined;

      return Effect.gen(function* () {
        while (replaying && replay) {
          const next = yield* Effect.tryPromise({
            try: () => replay.next(),
            catch: (error) => error,
          });

          if (next.done) {
            replaying = false;
            break;
          }

          const item: EventStreamItem = { kind: "replay", page: next.value };

          return one(item);
        }

        while (true) {
          const now = yield* Clock.currentTimeMillis;
          lastHeartbeatAt ??= now;

          const event = batch[batchIndex];

          if (event) {
            batchIndex += 1;
            lastSequence = event.sequence;

            const item: EventStreamItem = { kind: "event", event };

            return one(item);
          }

          if (now - lastHeartbeatAt >= heartbeatMs) {
            lastHeartbeatAt = now;

            const item: EventStreamItem = { kind: "heartbeat" };

            return one(item);
          }

          // A full page means more backlog is already committed; only wait at the tail.
          if (!fetchNow && batch.length < pageSize) yield* Effect.sleep(pollMs);
          fetchNow = false;
          batch = yield* Effect.tryPromise({
            try: () =>
              options.store.listEvents({
                threadId: options.threadId,
                after: lastSequence,
                limit: pageSize,
              }),
            catch: (error) => error,
          });
          batchIndex = 0;
        }
      });
    }),
  );
}

export type EventSocket = {
  destroyed: boolean;
  writableEnded: boolean;
  write(frame: string): boolean;
  once(event: "drain" | "close" | "error", listener: () => void): void;
  off(event: "drain" | "close" | "error", listener: () => void): void;
};

// Wait for the socket to drain before pulling another page from PostgreSQL.
export function writeFrame(socket: EventSocket, frame: string): Promise<void> {
  if (socket.destroyed || socket.writableEnded) return Promise.resolve();

  if (socket.write(frame)) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    function done(error?: Error) {
      socket.off("drain", done);
      socket.off("close", done);
      socket.off("error", onError);

      if (error) reject(error);
      else resolve();
    }

    function onError() {
      done(new Error("SSE socket failed"));
    }

    socket.once("drain", done);
    socket.once("close", done);
    socket.once("error", onError);
  });
}

export type EventFrameWriter = (item: EventStreamItem) => Promise<void>;

/** Consume an event stream with sequential response writes and interruption. */
export function consumeThreadEventStream(
  options: EventStreamOptions,
  write: EventFrameWriter,
  signal: AbortSignal,
): Promise<void> {
  return Effect.runPromise(
    Effect.scoped(
      Stream.runForEach(threadEventStream(options), (item) =>
        Effect.tryPromise({
          try: () => write(item),
          catch: (error) => error,
        }),
      ),
    ),
    { signal },
  );
}
