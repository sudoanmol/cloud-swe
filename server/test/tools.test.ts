import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { CreateSessionResponse, HistoryResponse, Session } from '@cloud-swe/protocol';
import type { ToolCall } from '@earendil-works/pi-ai';
import { Response as WorkerResponse } from 'miniflare';

import { modelAnswer } from './model-answer.ts';
import { runtime } from './runtime.ts';

test('native Pi read/write/edit and parallel bash calls use the session sandbox', { timeout: 40_000 }, async () => {
  const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-tools-'));
  const model = { provider: 'anthropic', id: 'claude-sonnet-5-5' };

  const calls: Array<Pick<ToolCall, 'id' | 'name' | 'arguments'>[]> = [
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

  const bodies: string[] = [];
  const dispatches: number[] = [];

  const mf = runtime(
    storage,
    { WORKSPACE_BACKEND: 'docker', MODEL_ID: model.id, ANTHROPIC_API_KEY: 'fake-key' },
    {
      outboundService: {
        type: 'fetcher',
        handler: async (request) => {
          if (new URL(request.url).hostname === 'api.anthropic.com') {
            bodies.push(await request.text());

            return modelAnswer(model.id, calls.shift() ?? []);
          }

          assert.equal(new URL(request.url).hostname, 'sandbox');

          if (request.url.endsWith('/commands')) dispatches.push(Date.now());

          const response = await fetch(request.url, {
            method: request.method,
            headers: [...request.headers],
            body: request.method === 'GET' ? undefined : await request.text(),
          });

          return new WorkerResponse(await response.arrayBuffer(), { status: response.status });
        },
      },
    },
  );

  const headers = { Authorization: 'Bearer integration-test-personal-token', 'Content-Type': 'application/json' };

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

    assert.equal(created.status, 201, await created.clone().text());
    const session = CreateSessionResponse.parse(await created.json()).session;
    assert.deepEqual(session.capabilities.tools, ['read', 'write', 'edit', 'bash', 'codemode']);
    const path = '/v1/sessions/' + session.id;

    const submitted = await fetch(new URL(path + '/messages', base), {
      method: 'POST',
      headers,
      body: JSON.stringify({ operationId: crypto.randomUUID(), text: 'Exercise the tools' }),
    });

    assert.equal(submitted.status, 202, await submitted.clone().text());
    let current = session;

    for (let attempt = 0; attempt < 500; attempt++) {
      current = Session.parse(await (await fetch(new URL(path, base), { headers })).json());

      if (current.run.kind === 'completed' || current.run.kind === 'failed') break;
      await setTimeout(20);
    }

    assert.equal(current.run.kind, 'completed', JSON.stringify(current.run));
    assert.equal(calls.length, 0);
    assert.equal(bodies.length, 6);
    assert.match(bodies[2] ?? '', /world/);
    assert.match(bodies[4] ?? '', /hello\\nPi/);
    assert.match(bodies[5] ?? '', /failing/);
    assert.match(bodies[5] ?? '', /exited with code 7/);
    assert.equal(dispatches.length, 3);
    assert.ok((dispatches[1] ?? 0) - (dispatches[0] ?? 0) < 1500, 'independent calls launch in parallel');

    const history = HistoryResponse.parse(
      await (await fetch(new URL(path + '/history?limit=100', base), { headers })).json(),
    );

    assert.ok(JSON.stringify(history).includes('write1'));
    assert.ok(JSON.stringify(history).includes('bash2'));
    assert.ok(bodies.every((body) => body.includes('"name":"read"') && body.includes('"name":"bash"')));
  } finally {
    await mf.dispose();
    await rm(storage, { recursive: true, force: true });
  }
});
