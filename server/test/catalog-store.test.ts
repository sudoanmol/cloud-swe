/**
 * Path: server/test/catalog-store.test.ts
 * Used by: pnpm test.
 * Purpose: Listing reads only the list keys, so a stored row from an older schema can't take the whole list down.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { listSessions } from '../src/sessions/catalog-store.ts';

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const key = (n: number) => `session:2026-10-30T00:00:0${n}.000Z:${id(n)}`;

// `engine` and `target` once were part of a stored creation; they make today's strict schema refuse the row.
const rows = new Map<string, object>([
  [key(1), { request: { engine: 'pi', target: 'cloud' }, sessionId: id(1) }],
  [key(2), { sessionId: id(2) }],
  [key(3), { sessionId: id(3) }],
]);

const storage = { list: async () => rows };

test('a stored session row that no longer parses still lists by its ID, with the cursor intact', async () => {
  const { page, hasMore } = await listSessions(storage, undefined, 2);

  assert.deepEqual(page, [
    { key: key(1), sessionId: id(1) },
    { key: key(2), sessionId: id(2) },
  ]);
  assert.equal(hasMore, true);
});
