/**
 * Path: server/test/event-stream.ts
 * Used by: server/test/{anthropic-live.test,delta-stream.test,lifecycle-rig,tool-events.test,transcript.test,two-clients.test}.ts.
 * Purpose: A session event stream client: applies each event to the snapshot it holds, as an app does, and checks the gap rule.
 */

import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

import { type Entry, SessionEvent, type Snapshot } from '@cloud-swe/protocol';

/** What a client holds: its view of the conversation, and the last SSE `id:` it saw (null when it holds no entry). */
export type Held = { snapshot: Snapshot | undefined; lastId: string | null };

/** One event as it arrived: its `id:` line, if it had one, and the state it left the client with. */
export type Received = { event: SessionEvent; id: string | undefined; state: Snapshot };

/**
 * The client's rules, which the Swift app follows too. Entries replace the entry with the same ID or are appended; `after`
 * must equal the last `id:` seen, or the client has missed entries.
 */
export function apply(state: Snapshot | undefined, event: SessionEvent, lastId: string | null): Snapshot {
  if (event.kind === 'snapshot') return structuredClone(event.snapshot);
  assert.ok(state, `a ${event.kind} event arrived before any snapshot`);

  switch (event.kind) {
    case 'session':
      return { ...state, session: event.session };
    case 'live':
      return { ...state, live: event.live };
    case 'entries': {
      assert.equal(event.after, lastId, 'entries.after is the last id: this connection sent');
      const entries: Entry[] = [...state.history.entries];

      for (const entry of event.entries) {
        const index = entries.findIndex((held) => held.id === entry.id);

        if (index >= 0) entries[index] = entry;
        else entries.push(entry);
      }

      return { ...state, history: { ...state.history, entries } };
    }
  }
}

/**
 * Whether a client's state matches the server's snapshot. The client keeps every entry it was sent, while a snapshot
 * holds the newest page, so the client's newest entries are compared. Its cursor to older pages is the one its own
 * snapshot gave, before its own first entry, so that field is not compared.
 */
export const sameState = (held: Snapshot | undefined, server: Snapshot) =>
  held !== undefined &&
  isDeepStrictEqual(
    { ...held, history: { entries: held.history.entries.slice(-server.history.entries.length), nextCursor: null } },
    { ...server, history: { ...server.history, nextCursor: null } },
  );

/** Reads a conversation's events for up to `timeoutMs`. A resumed client passes what it held from its last connection. */
export async function sessionEvents(
  url: URL,
  headers: Record<string, string>,
  held: Held = { snapshot: undefined, lastId: null },
  timeoutMs = 40_000,
) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type') ?? '', /text\/event-stream/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let { snapshot: state, lastId } = held;
  const received: Received[] = [];

  /** The next event, applied to what the client holds. */
  const read = async (): Promise<Received> => {
    for (;;) {
      const boundary = buffered.indexOf('\n\n');

      if (boundary >= 0) {
        const lines = buffered.slice(0, boundary).split('\n');
        buffered = buffered.slice(boundary + 2);
        const data = lines.find((line) => line.startsWith('data: '));

        if (!data) continue;
        const event = SessionEvent.parse(JSON.parse(data.slice(6)));
        assert.equal(
          lines.find((line) => line.startsWith('event:')),
          `event: ${event.kind}`,
        );
        const id = lines.find((line) => line.startsWith('id:'))?.replace(/^id: ?/, '');
        state = apply(state, event, lastId);

        if (id !== undefined) lastId = id === '' ? null : id;
        const arrived = { event, id, state };
        received.push(arrived);

        return arrived;
      }

      const chunk = await reader.read();
      assert.equal(chunk.done, false, 'SSE closed before the expected event');
      buffered += decoder.decode(chunk.value, { stream: true });
    }
  };

  /** The client's state after the next event. */
  const next = async () => (await read()).state;

  /** Reads events until the client's state matches; the stream's own timeout bounds the wait. */
  const until = async (matches: (snapshot: Snapshot) => boolean) => {
    for (;;) {
      const snapshot = await next();

      if (matches(snapshot)) return snapshot;
    }
  };

  return {
    read,
    next,
    until,
    received,
    held: (): Held => ({ snapshot: state, lastId }),
    close: () => reader.cancel(),
  };
}
