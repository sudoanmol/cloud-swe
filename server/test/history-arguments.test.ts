import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CreateSessionResponse, HistoryResponse, Snapshot } from '@cloud-swe/protocol';
import { Response as WorkerResponse } from 'miniflare';

import { modelAnswer } from './model-answer.ts';
import { runtime } from './runtime.ts';

const headers = { Authorization: 'Bearer integration-test-personal-token', 'Content-Type': 'application/json' };

test('history keeps tool arguments when the call is on an older page', { timeout: 30_000 }, async () => {
  const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-history-args-'));
  const model = { provider: 'anthropic', id: 'claude-sonnet-5-5' };
  const bindings = { WORKSPACE_BACKEND: 'docker', MODEL_ID: model.id, ANTHROPIC_API_KEY: 'fake-key' };
  let pendingCall = true;

  const dev = {
    outboundService: {
      type: 'fetcher',
      handler: async (request) => {
        if (new URL(request.url).hostname === 'api.anthropic.com') {
          const calls = pendingCall ? [{ id: 'call-A', name: 'bash', arguments: { command: 'printf hi' } }] : [];
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

    const submitted = await fetch(new URL(path + '/messages', base), {
      method: 'POST',
      headers,
      body: JSON.stringify({ operationId: crypto.randomUUID(), text: 'run it' }),
    });

    assert.equal(submitted.status, 202);

    for (let attempt = 0; attempt < 100; attempt++) {
      const snapshot = Snapshot.parse(await (await fetch(new URL(path + '/snapshot', base), { headers })).json());

      if (snapshot.session.run.kind === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    let cursor: string | null = null;
    const tools: unknown[] = [];

    do {
      const url = new URL(path + '/history?limit=1' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), base);
      const page = HistoryResponse.parse(await (await fetch(url, { headers })).json());

      for (const entry of page.entries) if (entry.kind === 'tool') tools.push(entry.arguments);
      cursor = page.nextCursor;
    } while (cursor);

    assert.deepEqual(tools, [{ command: 'printf hi' }]);
  } finally {
    await mf.dispose();
    await rm(storage, { recursive: true, force: true });
  }
});
