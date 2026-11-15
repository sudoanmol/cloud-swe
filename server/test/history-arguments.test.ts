/**
 * Path: server/test/history-arguments.test.ts
 * Used by: pnpm test.
 * Purpose: History keeps tool arguments when the call is on an older page.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { HistoryResponse } from '@cloud-swe/protocol';

import { lifecycleRig } from './lifecycle-rig.ts';

test('history keeps tool arguments when the call is on an older page', { timeout: 30_000 }, async () => {
  const rig = await lifecycleRig();

  try {
    const session = await rig.create();
    const call = { id: 'call-A', name: 'bash', arguments: { command: 'printf hi' } };
    await rig.accepted(await rig.send(session.id, 'run it', undefined, call));
    assert.equal((await rig.settled(session.id)).run.kind, 'completed');

    let cursor: string | null = null;
    const tools: unknown[] = [];

    do {
      const query = '/history?limit=1' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      const page = HistoryResponse.parse(await (await rig.api(`/v1/sessions/${session.id}${query}`)).json());

      for (const entry of page.entries) if (entry.kind === 'tool') tools.push(entry.arguments);
      cursor = page.nextCursor;
    } while (cursor);

    assert.deepEqual(tools, [{ command: 'printf hi' }]);
  } finally {
    await rig.close();
  }
});
