/**
 * Path: server/test/catalog-store.test.ts
 * Used by: pnpm test.
 * Purpose: The session list's rows: newest activity first, paged by order key, moved atomically when a session's summary changes, and a row that no longer parses left out without breaking the list.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { StoredSessionSummary } from '@cloud-swe/protocol/storage';

import { listSummaries, writeSummary } from '../src/sessions/catalog-store.ts';
import { memoryStorage } from './fakes.ts';

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

const row = (n: number, updatedAt: string) =>
  StoredSessionSummary.parse({
    sessionId: id(n),
    activeConversationId: '1',
    title: `Session ${n}`,
    preview: null,
    run: { kind: 'idle' },
    openRequests: 0,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt,
  });

const ids = (page: Awaited<ReturnType<typeof listSummaries>>) => page.sessions.map((session) => session.id);

test('the list is newest activity first, ties by ID, and pages by the last order key', async () => {
  const fake = memoryStorage();
  // SAFETY: the fake answers every storage call these functions make.
  const storage = fake as never;

  await writeSummary(storage, row(1, '2026-11-02T00:00:00.000Z'));
  await writeSummary(storage, row(2, '2026-11-03T00:00:00.000Z'));
  await writeSummary(storage, row(3, '2026-11-02T00:00:00.000Z'));

  const first = await listSummaries(storage, undefined, 2);
  assert.deepEqual(ids(first), [id(2), id(3)]);
  assert.ok(first.next);
  const second = await listSummaries(storage, first.next, 2);
  assert.deepEqual(ids(second), [id(1)]);
  assert.equal(second.next, undefined);

  // New activity moves the session to the top, and its old order key is gone.
  await writeSummary(storage, row(1, '2026-11-04T00:00:00.000Z'));
  assert.deepEqual(ids(await listSummaries(storage, undefined, 10)), [id(1), id(2), id(3)]);
  assert.equal([...fake.rows.keys()].filter((key) => key.startsWith('activity:')).length, 3);

  // A row that no longer parses is left out; the cursor still moves past it.
  fake.rows.set(`activity:2026-11-05T00:00:00.000Z:${id(4)}`, { unparsable: true });
  const page = await listSummaries(storage, undefined, 1);
  assert.deepEqual(ids(page), []);
  assert.deepEqual(ids(await listSummaries(storage, page.next, 1)), [id(1)]);
});
