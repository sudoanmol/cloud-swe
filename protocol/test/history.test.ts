import assert from 'node:assert/strict';
import test from 'node:test';

import { Entry, EntryId, Snapshot } from '../src/index.ts';
import { HistoryPosition } from '../src/storage.ts';

test('history preserves native entries without inventing an app run identity', () => {
  const sessionId = crypto.randomUUID();

  const entry = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    kind: 'native',
    nativeKind: 'pi.compaction',
    payload: { summary: 'context' },
  };

  assert.equal(EntryId.parse('42'), '42');
  assert.equal(EntryId.parse('live'), 'live');
  assert.equal(EntryId.safeParse('').success, false);
  assert.deepEqual(Entry.parse(entry), entry);
  assert.equal(Snapshot.safeParse({}).success, false);
  assert.ok(HistoryPosition.safeParse({ sessionId, native: { after: 42, order: 'descending' } }).success);
  assert.equal(HistoryPosition.safeParse({ sessionId: '1', native: {} }).success, false);
});
