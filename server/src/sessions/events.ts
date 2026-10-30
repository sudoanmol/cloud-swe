import { SessionEvent, type Session } from '@cloud-swe/protocol';
import type { OpenCommandOperation } from '@cloud-swe/protocol/tools';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import type { ConversationView } from '@earendil-works/pi-durable';
import type { PiHarness } from 'agents/harness/pi';
import { Effect, Queue, Stream } from 'effect';

import { snapshotFromView } from './transcript';

/** Each frame replaces the snapshot; coalescing never claims token/event replay. */
export function events(
  harness: PiHarness,
  currentSession: () => Promise<Session>,
  currentCommands: () => Promise<readonly OpenCommandOperation[]>,
): Response {
  const encoder = new TextEncoder();

  const stream = Stream.callback<Uint8Array>(
    (queue) =>
      Effect.gen(function* () {
        const watch = yield* Effect.acquireRelease(
          Effect.promise(async () => (await (await harness.pi()).root(BG)).watch(BG)),
          (watch) => Effect.promise(() => watch.stop()),
        );

        const emit = async (view: ConversationView) => {
          const snapshot = await snapshotFromView(harness, await currentSession(), view, await currentCommands());
          const event = SessionEvent.parse({ kind: 'snapshot', snapshot });
          Queue.offerUnsafe(queue, encoder.encode(`event: snapshot\ndata: ${JSON.stringify(event)}\n\n`));
        };

        yield* Effect.promise(() => emit(watch.value));
        watch.start((view) => emit(view));
        // Scope owns heartbeat and watch cleanup, including a cancelled HTTP response body.
        yield* Effect.forkScoped(
          Effect.forever(Effect.sleep('15 seconds').pipe(Effect.andThen(Effect.promise(() => emit(watch.value))))),
        );
        yield* Effect.promise(() => watch.closed);
        Queue.endUnsafe(queue);
      }),
    { bufferSize: 1, strategy: 'sliding' },
  ).pipe(Stream.catchCause(() => Stream.empty));

  return new Response(Stream.toReadableStream(stream), {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
