/**
 * Path: server/test/stream-step.test.ts
 * Used by: pnpm test.
 * Purpose: How the event stream turns one frame of conversation state into events: deltas, resets and re-sent entries.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { Entry, HISTORY_PAGE_LIMIT, LiveState, Session, SessionEvent, Snapshot } from '@cloud-swe/protocol';
import type { EntryRecord } from '@earendil-works/pi-durable';

import { resumed, type Sent, step } from '../src/sessions/events.ts';
import type { ConversationState } from '../src/sessions/transcript.ts';

const session = Session.parse(
  JSON.parse(readFileSync(new URL('../../protocol/fixtures/Session.json', import.meta.url), 'utf8')),
);

const live = LiveState.parse({ message: null, tools: [], toolsTruncated: false });

// SAFETY: Pi's IDs are numbers branded by kind; the stream reads only these fields of a record.
const record = (id: number, fields: { head?: number; byTaskId?: number } = {}): EntryRecord => ({
  id: id as EntryRecord['id'],
  conversationId: 1 as EntryRecord['conversationId'],
  kind: 'test',
  head: fields.head as EntryRecord['head'],
  byTaskId: fields.byTaskId as EntryRecord['byTaskId'],
});

/** A frame over these records, whose projection carries each record's outcome version in its payload. */
function state(records: EntryRecord[], remote: Record<number, string> = {}, current = live): ConversationState {
  const project = (chosen: readonly EntryRecord[]) =>
    chosen.map((each) =>
      Entry.parse({
        id: String(each.id),
        createdAt: session.createdAt,
        kind: 'native',
        nativeKind: 'test',
        payload: { remote: remote[Number(each.byTaskId)] ?? null },
      }),
    );

  return {
    records,
    session,
    live: current,
    remote: new Map(Object.entries(remote).map(([task, outcome]) => [Number(task), outcome])),
    project,
    snapshot: () =>
      Snapshot.parse({
        conversationId: '1',
        session,
        history: { entries: project(records.slice(-HISTORY_PAGE_LIMIT)), nextCursor: null },
        live: current,
      }),
  };
}

/** The frame's events, with each `id:` line. */
function events(frame: string) {
  return frame
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const data = lines.find((line) => line.startsWith('data: ')) ?? '';

      return {
        event: SessionEvent.parse(JSON.parse(data.slice(6))),
        id: lines.find((line) => line.startsWith('id:'))?.replace(/^id: ?/, ''),
      };
    });
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => record(from + index));

const kinds = (frame: string) => events(frame).map(({ event }) => event.kind);

test('a connection starts with a snapshot, then sends only what changed', () => {
  const start = step(undefined, state(range(1, 3)), true);
  assert.deepEqual(
    events(start.frame).map(({ event, id }) => [event.kind, id]),
    [['snapshot', '3']],
  );

  // Nothing changed and no heartbeat: nothing to send.
  assert.equal(step(start.sent, state(range(1, 3)), false).frame, '');

  // Two bursts committed between frames: one entries event after the last ID sent.
  const next = step(start.sent, state(range(1, 6)), false);
  const [entries] = events(next.frame);
  assert.equal(entries?.event.kind === 'entries' && entries.event.after, '3');
  assert.deepEqual(entries?.event.kind === 'entries' && entries.event.entries.map((entry) => entry.id), [
    '4',
    '5',
    '6',
  ]);
  assert.equal(entries?.id, '6');

  const beat = step(next.sent, state(range(1, 6)), true);
  assert.deepEqual(
    events(beat.frame).map(({ event, id }) => [event.kind, id]),
    [['session', undefined]],
  );

  const streaming = LiveState.parse({
    ...live,
    message: { createdAt: session.createdAt, content: [{ kind: 'text', text: 'hi' }] },
  });

  assert.deepEqual(kinds(step(beat.sent, state(range(1, 6), {}, streaming), false).frame), ['live']);
});

test('an empty conversation sends an empty id, and entries after it start with no after', () => {
  const start = step(undefined, state([]), true);
  assert.deepEqual(
    events(start.frame).map(({ id }) => id),
    [''],
  );
  const [entries] = events(step(start.sent, state(range(1, 2)), false).frame);
  assert.equal(entries?.event.kind === 'entries' && entries.event.after, null);
});

test('a head marker newer than the client, or more than a page of new entries, resets with a snapshot', () => {
  const start = step(undefined, state(range(1, 5)), true);
  // Compaction: a marker keeps entries from 4 on and goes in front.
  const compacted = [record(9, { head: 4 }), record(4), record(5)];
  assert.deepEqual(kinds(step(start.sent, state(compacted), false).frame), ['snapshot']);
  // Reset: the marker keeps only itself.
  assert.deepEqual(kinds(step(start.sent, state([record(6, { head: 6 })]), false).frame), ['snapshot']);
  // Entries after a marker the client already holds are plain appends.
  const after = step(undefined, state(compacted), true);
  assert.equal(after.sent.newest, 9);
  assert.deepEqual(kinds(step(after.sent, state([...compacted, record(10)]), false).frame), ['entries']);
  // More than one entries event can carry.
  assert.deepEqual(kinds(step(start.sent, state(range(1, 6 + HISTORY_PAGE_LIMIT)), false).frame), ['snapshot']);
});

test('a committed entry whose remote outcome changed is sent again, only if the client holds it', () => {
  const records = [...range(1, 2), record(3, { byTaskId: 7 }), record(4), record(5, { byTaskId: 8 })];
  const start = step(undefined, state(records, { 7: 'uncertain' }), true);
  const resolved = step(start.sent, state(records, {}), false);
  const [entries] = events(resolved.frame);
  assert.equal(entries?.event.kind, 'entries');

  if (entries?.event.kind === 'entries') {
    assert.equal(entries.event.after, '5');
    assert.deepEqual(
      entries.event.entries.map((entry) => entry.id),
      ['3'],
    );
  }

  assert.equal(entries?.id, '5');
  // A change to an entry not yet sent goes out with it as new; one older than the client's tail is history's.
  const old: Sent = { ...resolved.sent, floor: 4 };
  assert.equal(step(old, state(records, { 7: 'uncertain again' }), false).frame, '');
});

test('a resumed client gets session, the entries after its cursor, and live, or a snapshot', () => {
  const records = range(1, 10);
  assert.deepEqual(kinds(step(resumed(state(records), 7), state(records), true).frame), ['session', 'entries', 'live']);
  assert.deepEqual(kinds(step(resumed(state(records), 10), state(records), true).frame), ['session', 'live']);
  assert.deepEqual(kinds(step(resumed(state(records), 11), state(records), true).frame), ['snapshot']);

  const long = range(1, 1 + HISTORY_PAGE_LIMIT);
  assert.deepEqual(kinds(step(resumed(state(long), 1), state(long), true).frame), ['session', 'entries', 'live']);
  const longer = range(1, 2 + HISTORY_PAGE_LIMIT);
  assert.deepEqual(kinds(step(resumed(state(longer), 1), state(longer), true).frame), ['snapshot']);
});
