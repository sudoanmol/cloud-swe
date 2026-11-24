/**
 * Path: server/src/sessions/events.ts
 * Used by: server/src/sessions/thread.ts.
 * Purpose: A conversation's SSE stream: a snapshot, then only what changed (session, committed entries, live layer), resumable by entry ID, coalesced per frame window with a heartbeat.
 */

import { EntryId, HISTORY_PAGE_LIMIT, type Session, type SessionEvent } from '@cloud-swe/protocol';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import type { Conversation, ConversationView, EntryRecord } from '@earendil-works/pi-durable';
import { Cause, Effect, Queue, Stream } from 'effect';

import { logFault, logNotice } from '../errors.ts';
import { nativeId } from './pi.ts';
import type { ConversationState } from './transcript.ts';

// Streaming text stays live at roughly this rate; bursts of publications inside one window share a frame.
const FRAME_WINDOW = '100 millis';

// The heartbeat is a `session` event, and the only time the stream reads sandbox state from the Catalog.
const HEARTBEAT = '15 seconds';

type WorkspaceState = Session['workspace']['state'];

/** Where a stream reads from. `read` calls no other object; `workspace` is the Catalog call. */
export type EventSource = {
  read: (view: ConversationView, workspace: WorkspaceState) => Promise<ConversationState>;
  workspace: () => Promise<WorkspaceState>;
};

/** What one connection has sent its client: all the state it keeps between frames. */
export type Sent = {
  /** The newest committed entry the client holds, which the last SSE `id:` named. */
  newest: number | undefined;
  /** The oldest entry of the client's committed tail. A changed entry older than it is only in history pages. */
  floor: number;
  /** The session and live layer last sent, as JSON. */
  session: string;
  live: string;
  /** The remote outcomes the client's entries were projected with, by tool task. */
  remote: ReadonlyMap<number, string>;
  /** A resumed connection's first frame, which starts with the session. */
  resuming: boolean;
};

const id = (record: EntryRecord) => Number(record.id);

const newestOf = (records: readonly EntryRecord[]) => (records.length === 0 ? undefined : Math.max(...records.map(id)));

/**
 * The committed entries a client holding everything up to `newest` lacks, in transcript order, or undefined when
 * appending them can't express the change. Pi's view puts a head marker (compaction or reset) in front of the entries it
 * keeps and drops the rest, so a marker newer than the client's newest has rewritten its tail.
 */
function missing(records: readonly EntryRecord[], newest: number | undefined) {
  if (newest === undefined) return records.length > HISTORY_PAGE_LIMIT ? undefined : records;
  const [first] = records;

  if (first?.head !== undefined && id(first) > newest) return undefined;

  if (!records.some((record) => id(record) === newest)) return undefined;
  const fresh = records.filter((record) => id(record) > newest);

  return fresh.length > HISTORY_PAGE_LIMIT ? undefined : fresh;
}

/** The oldest entry a client with this view's bounded tail holds; when it holds none, the next one to commit. */
function floorOf(records: readonly EntryRecord[], newest: number | undefined) {
  const kept = records.slice(-HISTORY_PAGE_LIMIT).filter((record) => record.head === undefined);

  return Math.min(...kept.map(id), (newest ?? 0) + 1);
}

/** Tool tasks whose remote outcome differs between two frames. */
function changedTasks(before: ReadonlyMap<number, string>, after: ReadonlyMap<number, string>) {
  return new Set([...before.keys(), ...after.keys()].filter((task) => before.get(task) !== after.get(task)));
}

/** One SSE event. `newest` sets `id:`; null sets it empty, which tells an EventSource it holds no entry. */
const encode = (event: SessionEvent, newest?: number | null) =>
  `event: ${event.kind}\n${newest === undefined ? '' : `id: ${newest ?? ''}\n`}data: ${JSON.stringify(event)}\n\n`;

/** A snapshot for a connection that holds nothing usable: the start without a cursor, and every reset. */
function snapshot(state: ConversationState) {
  const newest = newestOf(state.records.slice(-HISTORY_PAGE_LIMIT));

  const sent: Sent = {
    newest,
    floor: floorOf(state.records, newest),
    session: JSON.stringify(state.session),
    live: JSON.stringify(state.live),
    remote: state.remote,
    resuming: false,
  };

  return { sent, frame: encode({ kind: 'snapshot', snapshot: state.snapshot() }, newest ?? null) };
}

/** A resumed connection: the client holds everything up to `after`, and nothing this connection sent. */
export const resumed = (state: ConversationState, after: number): Sent => ({
  newest: after,
  floor: floorOf(state.records, after),
  session: '',
  live: '',
  remote: new Map(),
  resuming: true,
});

/**
 * The events that bring a client from `sent` to `state`, or a snapshot when they can't. They come as `entries`, `live`,
 * `session`, so a run never shows as ended before its last entry, except that a resume starts with `session`, as the
 * contract says. A heartbeat always sends the session. A committed tool entry follows its remote command's outcome, so one
 * whose outcome changed since `sent` is sent again with its ID; no other committed entry is sent twice.
 */
export function step(sent: Sent | undefined, state: ConversationState, heartbeat: boolean) {
  const fresh = sent && missing(state.records, sent.newest);

  if (!sent || !fresh) return snapshot(state);
  const tasks = changedTasks(sent.remote, state.remote);
  const { floor, newest: held } = sent;

  const changed = state.records.filter(
    (record) =>
      held !== undefined &&
      record.head === undefined &&
      record.byTaskId !== undefined &&
      tasks.has(record.byTaskId) &&
      id(record) >= floor &&
      id(record) <= held,
  );

  if (changed.length + fresh.length > HISTORY_PAGE_LIMIT) return snapshot(state);
  const events: string[] = [];
  const session = JSON.stringify(state.session);
  const live = JSON.stringify(state.live);
  const newest = newestOf(fresh) ?? held;

  const sessionEvent =
    heartbeat || session !== sent.session ? [encode({ kind: 'session', session: state.session })] : [];

  if (changed.length + fresh.length > 0) {
    const after = held === undefined ? null : EntryId.parse(String(held));

    events.push(encode({ kind: 'entries', after, entries: state.project([...changed, ...fresh]) }, newest));
  }

  if (live !== sent.live) events.push(encode({ kind: 'live', live: state.live }));

  const frame = sent.resuming ? [...sessionEvent, ...events] : [...events, ...sessionEvent];

  return { sent: { newest, floor, session, live, remote: state.remote, resuming: false }, frame: frame.join('') };
}

/** An entry ID as the client sent it, if it can be one: Pi's are positive integers. */
const cursorOf = (after: string | undefined) => (after === undefined ? undefined : nativeId(after));

/**
 * The stream starts with a snapshot, or resumes after the entry `after` names, then sends what each frame changed.
 * State Pi doesn't publish, such as approvals, wakes the stream through a listener the Thread calls, held in `listeners`
 * while the stream lives.
 */
export function events(
  conversation: Conversation,
  source: EventSource,
  listeners: Set<() => void>,
  after: string | undefined,
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
      const changes = Stream.callback<'change'>(
        (queue) =>
          Effect.gen(function* () {
            wake = () => void Queue.offerUnsafe(queue, 'change');
            watch.start(async () => void Queue.offerUnsafe(queue, 'change'));
            const end = yield* Effect.promise(() => watch.closed);
            logNotice('Session event watch ended', { reason: end.reason });
            Queue.endUnsafe(queue);
          }),
        { bufferSize: 1, strategy: 'sliding' },
      );

      // The first tick is immediate, so the first frame is a heartbeat.
      const beats = Stream.tick(HEARTBEAT).pipe(Stream.map(() => 'heartbeat' as const));
      let resume = cursorOf(after);
      let sent: Sent | undefined;
      let workspace: WorkspaceState = 'unreachable';
      let started = false;

      // groupedWithin flushes after the first signal of a window, so it never starves under continuous streaming
      // (unlike debounce), never drops the final signal, and never delays it past one window. Each frame reads the
      // newest view and diffs it against what the connection sent, so a slow client gets the newest state, not a queue.
      return Stream.merge(changes, beats, { haltStrategy: 'left' }).pipe(
        Stream.groupedWithin(Number.MAX_SAFE_INTEGER, FRAME_WINDOW),
        Stream.mapEffect((signals) =>
          Effect.promise(async () => {
            const heartbeat = !started || signals.includes('heartbeat');
            started = true;

            if (heartbeat) workspace = await source.workspace();
            const state = await source.read(watch.value, workspace);

            if (resume !== undefined) sent = resumed(state, resume);
            resume = undefined;
            const next = step(sent, state, heartbeat);
            sent = next.sent;

            return encoder.encode(next.frame);
          }),
        ),
        Stream.filter((frame) => frame.byteLength > 0),
      );
    }),
  ).pipe(
    Stream.tapCause((cause) =>
      Effect.sync(() => {
        const error = Cause.squash(cause);

        if (error instanceof Error) logFault('Session event stream failed', error);
      }),
    ),
  );

  return new Response(Stream.toReadableStream(stream), {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
