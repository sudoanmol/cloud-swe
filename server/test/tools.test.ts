/**
 * Path: server/test/tools.test.ts
 * Used by: pnpm test.
 * Purpose: Native Pi read, write, edit and parallel bash use the session sandbox.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { lifecycleRig } from './lifecycle-rig.ts';
import { modelAnswer } from './model-answer.ts';
import { toolResults } from './provider-request.ts';
import { type Call, model } from './rig.ts';

test('native Pi read/write/edit and parallel bash calls use the session sandbox', { timeout: 40_000 }, async () => {
  const rig = await lifecycleRig();

  const calls: Call[][] = [
    [{ id: 'write1', name: 'write', arguments: { path: 'src/example.txt', content: 'hello\nworld\n' } }],
    [{ id: 'read1', name: 'read', arguments: { path: 'src/example.txt', offset: 2, limit: 1 } }],
    [
      {
        id: 'edit1',
        name: 'edit',
        arguments: { path: 'src/example.txt', edits: [{ oldText: 'world', newText: 'Pi' }] },
      },
    ],
    [
      { id: 'bash1', name: 'bash', arguments: { command: 'printf first; sleep 2; cat src/example.txt' } },
      { id: 'bash2', name: 'bash', arguments: { command: 'printf second; sleep 2; printf done' } },
    ],
    [{ id: 'bash3', name: 'bash', arguments: { command: 'printf failing; exit 7' } }],
  ];

  const dispatches: number[] = [];
  rig.setAnswer(() => modelAnswer(model.id, calls.shift() ?? []));
  rig.setIntercept((request) => {
    if (request.path.endsWith('/commands')) dispatches.push(Date.now());

    return undefined;
  });

  try {
    const session = await rig.create();
    await rig.accepted(await rig.send(session.id, 'Exercise the tools'));
    const current = await rig.settled(session.id);

    const { bodies } = rig;
    assert.equal(current.run.kind, 'completed', JSON.stringify(current.run));
    assert.equal(calls.length, 0);
    assert.equal(bodies.length, 6);
    assert.match(toolResults(bodies[2] ?? '').at(-1)?.output ?? '', /world/);
    assert.match(bodies[4] ?? '', /hello\\nPi/);
    const failed = toolResults(bodies[5] ?? '').at(-1);
    assert.equal(failed?.isError, true);
    assert.match(failed?.output ?? '', /failing/);
    assert.match(failed?.output ?? '', /exited with code 7/);
    assert.equal(dispatches.length, 3);
    assert.ok((dispatches[1] ?? 0) - (dispatches[0] ?? 0) < 1500, 'independent calls launch in parallel');

    const history = JSON.stringify(await rig.history(session.id));
    assert.ok(history.includes('write1'));
    assert.ok(history.includes('bash2'));
    assert.ok(bodies.every((body) => body.includes('"name":"read"') && body.includes('"name":"bash"')));
  } finally {
    await rig.close();
  }
});
