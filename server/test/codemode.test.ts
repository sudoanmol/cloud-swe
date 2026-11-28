/**
 * Path: server/test/codemode.test.ts
 * Used by: pnpm test.
 * Purpose: Durable codemode: sequential and parallel tools, isolation, interruption and budgets.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { lifecycleRig } from './lifecycle-rig.ts';
import { toolResults } from './provider-request.ts';
import { commandIdentity, commandProgress, waitFor } from './rig.ts';

test(
  'official durable codemode supports sequential and parallel tools, isolated globals, store and restart replay',
  { timeout: 60_000 },
  async () => {
    const rig = await lifecycleRig();
    const dispatches = () => rig.requests('POST', /\/commands$/).map(({ body }) => commandIdentity(body));
    const lastResult = () => toolResults(rig.bodies.at(-1) ?? '').at(-1)?.output ?? '';

    try {
      const session = await rig.create();

      const send = async (code: string) =>
        rig.accepted(
          await rig.send(session.id, 'Run the script', undefined, {
            id: crypto.randomUUID(),
            name: 'codemode',
            arguments: { code },
          }),
        );

      const settled = () => rig.settled(session.id);

      await send(`await tools.write({path: 'script.txt', content: 'from-script'});
store('file', 'script.txt');
const textFile = await tools.read({path: 'script.txt'});
const results = await Promise.all([
  tools.bash({command: 'printf parallel-one; sleep 1'}),
  tools.bash({command: 'printf parallel-two; sleep 1'})
]);
return {textFile, outputs: results.map(r => r.output)};`);
      assert.equal((await settled()).run.kind, 'completed');
      assert.match(rig.bodies.at(-1) ?? '', /from-script/);
      assert.match(rig.bodies.at(-1) ?? '', /parallel-one/);
      assert.match(rig.bodies.at(-1) ?? '', /parallel-two/);
      assert.equal(dispatches().length, 2);

      await send(`await tools.bash({command: 'printf once >> codemode-once.txt; printf before; sleep 4; cat codemode-once.txt'});
return {saved: load('file'), result: await tools.read({path: 'script.txt'})};`);

      await waitFor(
        async () => dispatches().length,
        (count) => count >= 3,
      );
      assert.equal(dispatches().length, 3);
      // Let the nested bash command start in the sandbox before the restart.
      await setTimeout(300);
      await rig.restart();
      assert.equal((await settled()).run.kind, 'completed');
      assert.equal(
        dispatches().length,
        3,
        'codemode replays its journal and reattaches to the original nested bash task',
      );
      assert.match(lastResult(), /script.txt/);
      assert.match(lastResult(), /from-script/);

      await send(
        `return {globals: [typeof process, typeof fetch, typeof require, typeof setTimeout, typeof models], recursion: ALL_TOOLS.some(t => t.name === 'codemode')};`,
      );
      assert.equal((await settled()).run.kind, 'completed');
      const isolated = toolResults(rig.bodies.at(-1) ?? '').at(-1)?.output ?? '';
      assert.equal(isolated.match(/undefined/g)?.length, 5);
      assert.match(isolated, /"recursion":false/);

      await send(
        `await tools.write({path: 'kept.txt', content: 'kept-effect'}); store('discard', 'not-committed'); throw new Error('expected-script-error');`,
      );
      assert.equal((await settled()).run.kind, 'completed');
      assert.match(lastResult(), /expected-script-error/);
      await send(`return {discard: load('discard') ?? null, kept: await tools.read({path: 'kept.txt'})};`);
      assert.equal((await settled()).run.kind, 'completed');
      assert.match(lastResult(), /kept-effect/);
      assert.doesNotMatch(lastResult(), /not-committed/);

      await send(
        `await tools.write({path: 'large.txt', content: Array.from({length: 10000}, (_, i) => 'line-' + (i + 1) + '-contents').join('\\n')}); return await tools.read({path: 'large.txt', offset: 9000, limit: 2});`,
      );
      assert.equal((await settled()).run.kind, 'completed');
      const selected = toolResults(rig.bodies.at(-1) ?? '').at(-1)?.output ?? '';
      assert.match(selected, /line-9000-contents/);
      assert.match(selected, /line-9001-contents/);
      assert.doesNotMatch(selected, /line-9002-contents/);

      await send(`// @options: {"max_output_tokens": 50}
text('x'.repeat(30000)); return 'spill-tail';`);
      assert.equal((await settled()).run.kind, 'completed');
      const spilled = toolResults(rig.bodies.at(-1) ?? '').at(-1)?.output ?? '';
      assert.match(spilled, /spill-tail/);
      assert.match(spilled, /Full output:/);
      assert.doesNotMatch(spilled, /Could not save/);

      // A script that returns stops the nested command it did not await before it settles.
      const first = dispatches().length;
      await send(
        `const ignored = tools.bash({command: 'printf orphan-start; sleep 10; printf must-not-continue'}); await tools.bash({command: 'sleep 0.5'}); return 'parent-finished';`,
      );
      assert.equal((await settled()).run.kind, 'completed');
      assert.match(lastResult(), /parent-finished/);
      const returned = await Promise.all(dispatches().slice(first).map(commandProgress));
      const orphan = returned.find((p) => p?.output.includes('orphan-start'));
      assert.equal(orphan?.kind === 'exited' && orphan.termination, 'cancelled');
      assert.doesNotMatch(orphan?.output ?? '', /must-not-continue/);

      await send(`while (true) {}`);
      assert.equal(
        (await settled()).run.kind,
        'completed',
        'interrupt budget fails the script without blocking the Thread',
      );
      assert.match(lastResult(), /exceeded its interrupt budget/);
    } finally {
      await rig.close();
    }
  },
);
