/**
 * Path: server/test/codemode.test.ts
 * Used by: pnpm test.
 * Purpose: Durable codemode: sequential and parallel tools, isolation, interruption and budgets.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { CreateSessionResponse, Session } from '@cloud-swe/protocol';
import type { ToolCall } from '@earendil-works/pi-ai';
import { Response as WorkerResponse } from 'miniflare';

import { modelAnswer } from './model-answer.ts';
import { toolResults } from './provider-request.ts';
import { commandIdentity, commandProgress, headers, model, waitFor } from './rig.ts';
import { runtime, type RuntimeOptions } from './runtime.ts';

test(
  'official durable codemode supports sequential and parallel tools, isolated globals, store and restart replay',
  { timeout: 60_000 },
  async () => {
    const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-codemode-'));
    const bindings = { WORKSPACE_BACKEND: 'docker', MODEL_ID: model.id, ANTHROPIC_API_KEY: 'fake-key' };
    let next: Pick<ToolCall, 'id' | 'name' | 'arguments'> | undefined;
    const dispatches: ReturnType<typeof commandIdentity>[] = [];
    const bodies: string[] = [];
    const lastResult = () => toolResults(bodies.at(-1) ?? '').at(-1)?.output ?? '';

    const dev = {
      outboundService: {
        type: 'fetcher',
        handler: async (request) => {
          if (new URL(request.url).hostname === 'api.anthropic.com') {
            bodies.push(await request.text());
            const call = next;
            next = undefined;

            return modelAnswer(model.id, call ? [call] : []);
          }

          assert.equal(new URL(request.url).hostname, 'sandbox');

          const body = request.method === 'GET' ? undefined : await request.text();

          if (request.url.endsWith('/commands')) dispatches.push(commandIdentity(body ?? ''));

          const response = await fetch(request.url, { method: request.method, headers: [...request.headers], body });

          return new WorkerResponse(await response.arrayBuffer(), { status: response.status });
        },
      },
    } satisfies NonNullable<RuntimeOptions['dev']>;

    let mf = runtime(storage, { bindings, dev });
    let base = await mf.ready;
    let path = '';

    const send = async (code: string) => {
      next = { id: crypto.randomUUID(), name: 'codemode', arguments: { code } };

      const response = await fetch(new URL(path + '/messages', base), {
        method: 'POST',
        headers,
        body: JSON.stringify({ operationId: crypto.randomUUID(), text: 'Run the script' }),
      });

      assert.equal(response.status, 202, await response.clone().text());
    };

    const settled = () =>
      waitFor(
        async () => Session.parse(await (await fetch(new URL(path, base), { headers })).json()),
        (current) => ['completed', 'cancelled', 'failed'].includes(current.run.kind),
      );

    try {
      const created = await fetch(new URL('/v1/sessions', base), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          template: 'base',
          model,
        }),
      });

      assert.equal(created.status, 201);
      const session = CreateSessionResponse.parse(await created.json()).session;
      path = '/v1/sessions/' + session.id;

      await send(`await tools.write({path: 'script.txt', content: 'from-script'});
store('file', 'script.txt');
const textFile = await tools.read({path: 'script.txt'});
const results = await Promise.all([
  tools.bash({command: 'printf parallel-one; sleep 1'}),
  tools.bash({command: 'printf parallel-two; sleep 1'})
]);
return {textFile, outputs: results.map(r => r.output)};`);
      assert.equal((await settled()).run.kind, 'completed');
      assert.match(bodies.at(-1) ?? '', /from-script/);
      assert.match(bodies.at(-1) ?? '', /parallel-one/);
      assert.match(bodies.at(-1) ?? '', /parallel-two/);
      assert.equal(dispatches.length, 2);

      await send(`await tools.bash({command: 'printf once >> codemode-once.txt; printf before; sleep 4; cat codemode-once.txt'});
return {saved: load('file'), result: await tools.read({path: 'script.txt'})};`);

      await waitFor(
        async () => dispatches.length,
        (count) => count >= 3,
      );
      assert.equal(dispatches.length, 3);
      await setTimeout(300);
      await mf.dispose();
      mf = runtime(storage, { bindings, dev });
      base = await mf.ready;
      assert.equal((await settled()).run.kind, 'completed');
      assert.equal(
        dispatches.length,
        3,
        'codemode replays its journal and reattaches to the original nested bash task',
      );
      assert.match(lastResult(), /script.txt/);
      assert.match(lastResult(), /from-script/);

      await send(
        `return {globals: [typeof process, typeof fetch, typeof require, typeof setTimeout, typeof models], recursion: ALL_TOOLS.some(t => t.name === 'codemode')};`,
      );
      assert.equal((await settled()).run.kind, 'completed');
      const isolated = toolResults(bodies.at(-1) ?? '').at(-1)?.output ?? '';
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
      const selected = toolResults(bodies.at(-1) ?? '').at(-1)?.output ?? '';
      assert.match(selected, /line-9000-contents/);
      assert.match(selected, /line-9001-contents/);
      assert.doesNotMatch(selected, /line-9002-contents/);

      await send(`// @options: {"max_output_tokens": 50}
text('x'.repeat(30000)); return 'spill-tail';`);
      assert.equal((await settled()).run.kind, 'completed');
      const spilled = toolResults(bodies.at(-1) ?? '').at(-1)?.output ?? '';
      assert.match(spilled, /spill-tail/);
      assert.match(spilled, /Full output:/);
      assert.doesNotMatch(spilled, /Could not save/);

      // A script that returns stops the nested command it did not await before it settles.
      const first = dispatches.length;
      await send(
        `const ignored = tools.bash({command: 'printf orphan-start; sleep 10; printf must-not-continue'}); await tools.bash({command: 'sleep 0.5'}); return 'parent-finished';`,
      );
      assert.equal((await settled()).run.kind, 'completed');
      assert.match(lastResult(), /parent-finished/);
      const returned = await Promise.all(dispatches.slice(first).map((id) => commandProgress(id)));
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
      await mf.dispose();
      await rm(storage, { recursive: true, force: true });
    }
  },
);
