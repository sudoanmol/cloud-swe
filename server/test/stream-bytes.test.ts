/**
 * Path: server/test/stream-bytes.test.ts
 * Used by: pnpm test.
 * Purpose: Measures the bytes the event stream sends over one streamed model turn on a session with some history.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { lifecycleRig } from './lifecycle-rig.ts';
import { streamedAnswer } from './model-answer.ts';
import { headers, model } from './rig.ts';

test('bytes sent over one streamed turn', { timeout: 90_000 }, async (t) => {
  const rig = await lifecycleRig();

  try {
    const session = await rig.create();
    // History first: a tool call with a few kilobytes of output, as a real transcript has.
    await rig.accepted(await rig.send(session.id, 'Make some history', undefined, rig.bash('seq 1 1000')));
    assert.equal((await rig.settled(session.id)).run.kind, 'completed');

    const response = await fetch(new URL(rig.conversation(session.id) + '/events', rig.base()), { headers });
    assert.ok(response.body);
    const reader = response.body.getReader();
    let bytes = 0;
    let frames = 0;
    let first = 0;

    const reading = (async () => {
      for (;;) {
        const chunk = await reader.read();

        if (chunk.done) return;
        bytes += chunk.value.byteLength;
        frames += new TextDecoder().decode(chunk.value).split('\n\n').length - 1;
      }
    })().catch(() => {});

    await setTimeout(1000);
    first = bytes;

    const chunks = Array.from({ length: 40 }, (_, index) => `chunk ${index} of a streamed answer; `);
    rig.setAnswer(() => streamedAnswer(model.id, chunks, 50));
    await rig.accepted(await rig.send(session.id, 'Stream an answer'));
    assert.equal((await rig.settled(session.id)).run.kind, 'completed');
    await setTimeout(500);
    await reader.cancel();
    await reading;

    t.diagnostic(`connect: ${first} bytes; whole turn: ${bytes} bytes in ${frames} SSE events`);
    assert.ok(bytes > first);
  } finally {
    await rig.close();
  }
});
