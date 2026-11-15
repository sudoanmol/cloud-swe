/**
 * Path: server/test/event-frames.test.ts
 * Used by: pnpm test.
 * Purpose: A burst of Pi publications coalesces into fewer SSE frames, ending on the final state.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { lifecycleRig } from './lifecycle-rig.ts';

const writes = 60;

test('a burst of publications is coalesced into fewer frames and the last frame has the final state', async () => {
  const rig = await lifecycleRig();

  try {
    const session = await rig.create();
    const stream = await rig.events(session.id);
    await stream.next();

    const code = `for (let i = 0; i < ${writes}; i++) await tools.write({path: 'f' + i + '.txt', content: 'x'}); return 'done';`;
    await rig.accepted(
      await rig.send(session.id, 'burst', undefined, { id: 'burst', name: 'codemode', arguments: { code } }),
    );

    let frames = 0;
    let last = await stream.next();

    const finished = () =>
      last.session.run.kind === 'completed' &&
      last.history.entries.some((entry) => entry.kind === 'tool' && entry.name === 'codemode');

    while (!finished()) {
      frames++;
      last = await stream.next();
    }

    const codemode = last.history.entries.find((entry) => entry.kind === 'tool' && entry.name === 'codemode');
    assert.equal(codemode?.kind === 'tool' ? codemode.nestedCalls.length : 0, writes);
    // Every nested write commits at least once, so publications >= writes.
    assert.ok(frames < writes, `${frames} frames for at least ${writes} publications`);
    await stream.close();
  } finally {
    await rig.close();
  }
});
