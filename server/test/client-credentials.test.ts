import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { CreateSessionResponse, Session } from '@cloud-swe/protocol';
import { ModelCredentialStatus } from '@cloud-swe/protocol/credentials';
import { Response as WorkerResponse } from 'miniflare';

import { modelAnswer } from './model-answer.ts';
import { runtime } from './runtime.ts';

test(
  'client keys rotate live, survive restart and delete without falling back to a Worker secret',
  { timeout: 30_000 },
  async () => {
    const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-keys-'));
    const model = { provider: 'anthropic', id: 'claude-sonnet-5-5' };
    const bindings = { WORKSPACE_BACKEND: 'docker', MODEL_ID: model.id, ANTHROPIC_API_KEY: 'worker-test-fallback' };
    const seen: string[] = [];

    const dev = {
      outboundService: {
        type: 'fetcher',
        handler: async (request) => {
          if (new URL(request.url).hostname === 'api.anthropic.com') {
            seen.push(request.headers.get('x-api-key') ?? '');

            return modelAnswer(model.id);
          }

          assert.equal(new URL(request.url).hostname, 'sandbox');

          const response = await fetch(request.url, {
            method: request.method,
            headers: [...request.headers],
            body: request.method === 'GET' ? undefined : await request.text(),
          });

          return new WorkerResponse(await response.arrayBuffer(), { status: response.status });
        },
      },
    } satisfies NonNullable<Parameters<typeof runtime>[2]>;

    let mf = runtime(storage, bindings, dev);
    let base = await mf.ready;
    const auth = { Authorization: 'Bearer integration-test-personal-token', 'Content-Type': 'application/json' };
    const path = '/v1/credentials/models/anthropic';

    const request = (url: string, method = 'GET', body?: Record<string, string | typeof model>) =>
      fetch(
        new URL(url, base),
        method === 'GET' ? { headers: auth } : { method, headers: auth, body: body ? JSON.stringify(body) : undefined },
      );

    const status = async () => ModelCredentialStatus.parse(await (await request(path)).json());

    try {
      assert.equal((await fetch(new URL(path, base))).status, 401);
      assert.equal((await status()).source, 'worker');
      assert.equal((await request(path, 'PUT', { key: ' ' })).status, 400);
      assert.equal((await request('/v1/credentials/models/openai')).status, 400);
      const set = await request(path, 'PUT', { key: 'client-key-one' });
      assert.equal(set.headers.get('Cache-Control'), 'no-store');
      assert.deepEqual(ModelCredentialStatus.parse(await set.json()), {
        provider: 'anthropic',
        source: 'client',
        configured: true,
      });

      const created = await request('/v1/sessions', 'POST', {
        operationId: crypto.randomUUID(),
        engine: 'pi',
        target: 'cloud',
        environment: 'base',
        model,
      });

      assert.equal(created.status, 201, await created.clone().text());
      const { session } = CreateSessionResponse.parse(await created.json());
      const sessionPath = '/v1/sessions/' + session.id;
      const getSession = async () => Session.parse(await (await request(sessionPath)).json());

      const submit = () =>
        request(sessionPath + '/messages', 'POST', { operationId: crypto.randomUUID(), text: 'hello' });

      const settle = async () => {
        for (let attempt = 0; attempt < 200; attempt++) {
          const current = await getSession();

          if (current.run.kind === 'completed') return;
          await setTimeout(10);
        }

        throw new Error('Model did not settle');
      };

      assert.equal((await submit()).status, 202);
      await settle();
      assert.equal(seen[0], 'client-key-one');
      assert.equal((await request(path, 'PUT', { key: 'client-key-two' })).status, 200);
      assert.equal((await submit()).status, 202);
      await settle();
      assert.deepEqual(seen, ['client-key-one', 'client-key-two']);
      await mf.dispose();
      mf = runtime(storage, bindings, dev);
      base = await mf.ready;
      assert.equal((await status()).source, 'client');
      assert.equal((await submit()).status, 202);
      await settle();
      assert.equal(seen[2], 'client-key-two');
      assert.equal((await request(path, 'DELETE')).status, 200);
      assert.equal((await status()).source, 'disabled');
      assert.equal((await getSession()).capabilities.submitMessage, false);
      assert.equal((await submit()).status, 503);
      await mf.dispose();
      mf = runtime(storage, bindings, dev);
      base = await mf.ready;
      assert.equal((await status()).source, 'disabled');
      assert.equal((await submit()).status, 503);
      assert.equal(seen.length, 3);
      const database = await mf.unsafeGetDurableObjectStorage('cloud-swe-server', 'Thread', { name: session.id });

      for (const table of ['pi_entries', 'pi_tasks', 'pi_submissions', 'pi_documents']) {
        assert.equal(JSON.stringify(await database.exec(`SELECT * FROM ${table}`)).includes('client-key-'), false);
      }
    } finally {
      await mf.dispose();
      await rm(storage, { recursive: true, force: true });
    }
  },
);
