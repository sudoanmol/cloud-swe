import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { ApiError, CreateSessionResponse, Session } from '@cloud-swe/protocol';
import { Response as WorkerResponse } from 'miniflare';

import { modelAnswer } from './model-answer.ts';
import { runtime } from './runtime.ts';

const headers = { Authorization: 'Bearer integration-test-personal-token', 'Content-Type': 'application/json' };
const model = { provider: 'anthropic', id: 'claude-sonnet-5-5' };

test(
  'a credentials outage during submission is a sanitized 503 and does not reset the Thread',
  { timeout: 30_000 },
  async () => {
    const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-credentials-outage-'));
    let modelRequests = 0;
    let release: (() => void) | undefined;
    let down = false;

    const dev = {
      outboundService: {
        type: 'fetcher',
        handler: async (request) => {
          if (new URL(request.url).hostname !== 'api.anthropic.com') {
            const response = await fetch(request.url, { method: request.method, headers: [...request.headers] });

            return new WorkerResponse(await response.arrayBuffer(), { status: response.status });
          }

          modelRequests++;

          await new Promise<void>((resolve) => {
            release = resolve;
          });

          return modelAnswer(model.id);
        },
      },
    } satisfies NonNullable<Parameters<typeof runtime>[2]>;

    const credentialsSwitch = {
      outboundService: { type: 'fetcher', handler: async () => new WorkerResponse(down ? 'down' : 'up') },
    } satisfies NonNullable<Parameters<typeof runtime>[3]>;

    const mf = runtime(storage, { WORKSPACE_BACKEND: 'docker', MODEL_ID: model.id }, dev, credentialsSwitch);

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

      assert.equal(created.status, 201);
      const path = '/v1/sessions/' + CreateSessionResponse.parse(await created.json()).session.id;

      const send = (operationId: string) =>
        fetch(new URL(path + '/messages', base), {
          method: 'POST',
          headers,
          body: JSON.stringify({ operationId, text: 'hello' }),
        });

      assert.equal((await send(crypto.randomUUID())).status, 202);

      while (modelRequests === 0) await setTimeout(20);
      down = true;

      const secondId = crypto.randomUUID();
      const rejected = await send(secondId);
      assert.equal(rejected.status, 503);
      assert.equal(ApiError.parse(await rejected.json()).error.code, 'unavailable');

      down = false;
      release?.();
      let run: Session['run'] | undefined;

      for (let attempt = 0; attempt < 500 && run?.kind !== 'completed'; attempt++) {
        run = Session.parse(await (await fetch(new URL(path, base), { headers })).json()).run;
        await setTimeout(20);
      }

      assert.equal(run?.kind, 'completed');
      // A reset would abandon the in-flight provider call and issue it again after recovery.
      assert.equal(modelRequests, 1);
      assert.equal((await send(secondId)).status, 202, 'the same operation is accepted once credentials return');
    } finally {
      await mf.dispose();
      await rm(storage, { recursive: true, force: true });
    }
  },
);
