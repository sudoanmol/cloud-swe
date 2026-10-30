import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CreateSessionResponse } from '@cloud-swe/protocol';
import { Response as WorkerResponse } from 'miniflare';

import { sessionEvents } from './event-stream.ts';
import { modelAnswer } from './model-answer.ts';
import { runtime } from './runtime.ts';

const headers = { Authorization: 'Bearer integration-test-personal-token', 'Content-Type': 'application/json' };
const writes = 60;

test('a burst of publications is coalesced into fewer frames and the last frame has the final state', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-frames-'));
  const model = { provider: 'anthropic', id: 'claude-sonnet-5-5' };
  const bindings = { WORKSPACE_BACKEND: 'docker', MODEL_ID: model.id, ANTHROPIC_API_KEY: 'fake-key' };
  let pendingCall = true;

  const dev = {
    outboundService: {
      type: 'fetcher',
      handler: async (request) => {
        if (new URL(request.url).hostname === 'api.anthropic.com') {
          const code = `for (let i = 0; i < ${writes}; i++) await tools.write({path: 'f' + i + '.txt', content: 'x'}); return 'done';`;
          const calls = pendingCall ? [{ id: 'burst', name: 'codemode', arguments: { code } }] : [];
          pendingCall = false;

          return modelAnswer(model.id, calls);
        }

        const response = await fetch(request.url, {
          method: request.method,
          headers: [...request.headers],
          body: request.method === 'GET' ? undefined : await request.text(),
        });

        return new WorkerResponse(await response.arrayBuffer(), { status: response.status });
      },
    },
  } satisfies NonNullable<Parameters<typeof runtime>[2]>;

  const mf = runtime(storage, bindings, dev);

  try {
    const base = await mf.ready;

    const created = await fetch(new URL('/v1/sessions', base), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        engine: 'pi',
        target: 'cloud',
        environment: 'base',
        model,
      }),
    });

    const path = '/v1/sessions/' + CreateSessionResponse.parse(await created.json()).session.id;
    const stream = await sessionEvents(new URL(path + '/events', base), headers);
    await stream.next();

    await fetch(new URL(path + '/messages', base), {
      method: 'POST',
      headers,
      body: JSON.stringify({ operationId: crypto.randomUUID(), text: 'burst' }),
    });

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
    await mf.dispose();
    await rm(storage, { recursive: true, force: true });
  }
});
