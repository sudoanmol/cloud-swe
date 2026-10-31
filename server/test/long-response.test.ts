import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { lifecycleRig } from './lifecycle-rig.ts';
import { modelAnswer, streamedAnswer } from './model-answer.ts';

const MODEL = 'claude-sonnet-5-5';
const STREAM_SECONDS = 8;

test(
  'a slow generation holds the sandbox past its deadline and arrives whole',
  { timeout: 60_000 + STREAM_SECONDS * 2_000 },
  async () => {
    const rig = await lifecycleRig({ KEEPALIVE_INTERVAL_SECONDS: '1' });

    try {
      const session = await rig.create();
      // Only renewals keep the sandbox past this deadline, and no command is running to renew for.
      await rig.sandbox(session.workspace.id, '/ttl', JSON.stringify({ ttlSeconds: 2 }));
      const chunks = Array.from({ length: STREAM_SECONDS * 2 }, (_, index) => `part-${index};`);
      rig.setAnswer(() => streamedAnswer(MODEL, chunks, 500));

      await rig.accepted(await rig.send(session.id, 'Write for a long time'));
      assert.equal((await rig.settled(session.id)).run.kind, 'completed');
      assert.equal(await rig.boxState(session.workspace.id), 'running');
      assert.ok(JSON.stringify(await rig.history(session.id)).includes(chunks.join('')), 'no part was lost');
      assert.equal(rig.bodies.length, 1, 'the generation ran once');
    } finally {
      await rig.close();
    }
  },
);

test('a very large generation is stored and readable', { timeout: 120_000 }, async () => {
  const rig = await lifecycleRig();

  try {
    const session = await rig.create();
    // About 128K output tokens: the most a current model returns in one response.
    const chunk = 'x'.repeat(16_000);
    const chunks = [...Array.from({ length: 40 }, () => chunk), 'END-OF-LARGE-ANSWER'];
    rig.setAnswer(() => streamedAnswer(MODEL, chunks, 0));

    await rig.accepted(await rig.send(session.id, 'Write a lot'));
    assert.equal((await rig.settled(session.id)).run.kind, 'completed');
    const history = JSON.stringify(await rig.history(session.id));
    assert.ok(history.includes(chunks.join('')), 'the whole answer reads back');
  } finally {
    await rig.close();
  }
});

test('a restart during a generation retries it, so the run still completes', { timeout: 120_000 }, async () => {
  const rig = await lifecycleRig();

  try {
    const session = await rig.create();
    const chunks = Array.from({ length: 40 }, (_, index) => `part-${index};`);
    let answers = 0;

    rig.setAnswer(() => {
      answers++;

      return answers === 1 ? streamedAnswer(MODEL, chunks, 500) : modelAnswer(MODEL, [], { text: 'after-restart' });
    });

    await rig.accepted(await rig.send(session.id, 'Write for a long time'));
    await rig.until(
      async () => answers,
      (count) => count >= 1,
    );
    await setTimeout(1500);
    await rig.restart();

    assert.equal((await rig.settled(session.id)).run.kind, 'completed');
    assert.equal(answers, 2, 'the interrupted generation ran again, once');
    const history = JSON.stringify(await rig.history(session.id));
    assert.ok(history.includes('after-restart'));
    assert.equal(history.includes('part-39;'), false, 'the abandoned stream did not finish');
  } finally {
    await rig.close();
  }
});
