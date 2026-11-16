/**
 * Path: server/src/sessions/events.ts
 * Used by: server/src/sessions/thread.ts.
 * Purpose: A conversation's SSE stream: coalesces Pi watch changes and Thread changes into full snapshot frames, with a heartbeat and scoped cleanup.
 */

import type { Snapshot } from '@cloud-swe/protocol';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import type { Conversation, ConversationView } from '@earendil-works/pi-durable';
import { Effect, Queue, Stream } from 'effect';

// Streaming text stays live at roughly this rate; bursts of publications inside one window share a frame.
const FRAME_WINDOW = '100 millis';
const HEARTBEAT = '15 seconds';

/**
 * Each frame replaces the snapshot; coalescing never claims token/event replay. State Pi doesn't publish, such as
 * approvals, wakes the stream through a listener the Thread calls, held in `listeners` while the stream lives.
 */
export function events(
  conversation: Conversation,
  snapshot: (view: ConversationView) => Promise<Snapshot>,
  listeners: Set<() => void>,
): Response {
  const encoder = new TextEncoder();

  const stream = Stream.unwrap(
    Effect.gen(function* () {
      // The stream's scope owns the watch, so a cancelled response body stops it too.
      const watch = yield* Effect.acquireRelease(
        Effect.promise(() => conversation.watch(BG)),
        (watch) => Effect.promise(() => watch.stop()),
      );

      let wake = () => {};
      const listener = () => wake();

      yield* Effect.acquireRelease(
        Effect.sync(() => listeners.add(listener)),
        () => Effect.sync(() => listeners.delete(listener)),
      );

      // One signal per publication, in Pi's serial delivery order. A sliding buffer of one keeps the newest signal.
      const changes = Stream.callback<void>(
        (queue) =>
          Effect.gen(function* () {
            wake = () => void Queue.offerUnsafe(queue, undefined);
            watch.start(async () => void Queue.offerUnsafe(queue, undefined));
            const end = yield* Effect.promise(() => watch.closed);
            yield* Effect.logWarning('Session event watch ended', end.reason);
            Queue.endUnsafe(queue);
          }),
        { bufferSize: 1, strategy: 'sliding' },
      );

      // groupedWithin flushes after the first signal of a window, so it never starves under continuous
      // streaming (unlike debounce), never drops the final signal, and never delays it past one window.
      return Stream.make(undefined).pipe(
        Stream.concat(Stream.merge(changes, Stream.tick(HEARTBEAT), { haltStrategy: 'left' })),
        Stream.groupedWithin(Number.MAX_SAFE_INTEGER, FRAME_WINDOW),
        Stream.mapEffect(() =>
          Effect.promise(async () => {
            const event = { kind: 'snapshot', snapshot: await snapshot(watch.value) };

            return encoder.encode(`event: snapshot\ndata: ${JSON.stringify(event)}\n\n`);
          }),
        ),
      );
    }),
  ).pipe(Stream.tapCause((cause) => Effect.logError('Session event stream failed', cause)));

  return new Response(Stream.toReadableStream(stream), {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
