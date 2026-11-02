/**
 * Path: server/test/credentials.test.ts
 * Used by: pnpm test.
 * Purpose: Model credentials: sanitized provider failures, live key rotation and deletion, and a credentials outage during submission.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { ApiError, CreateSessionResponse, Session } from '@cloud-swe/protocol';
import { ModelCredentialStatus } from '@cloud-swe/protocol/credentials';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { Response as WorkerResponse } from 'miniflare';

import { sanitizedProvider, secretCredentials, sessionModels } from '../src/sessions/models.ts';
import { modelAnswer } from './model-answer.ts';
import { runtime } from './runtime.ts';

test('Worker credentials resolve through real Pi auth without exposing secrets in metadata', async () => {
  const credentials = secretCredentials({ ANTHROPIC_API_KEY: '  test-private-key  ' });
  const models = sessionModels({ ANTHROPIC_API_KEY: '  test-private-key  ' });

  assert.deepEqual(await models.getAuth('anthropic'), {
    auth: { apiKey: 'test-private-key' },
    env: undefined,
    source: 'stored credential',
  });
  assert.deepEqual(await credentials.list(), [{ providerId: 'anthropic', type: 'api_key' }]);
  assert.equal(await credentials.read('openai'), undefined);
  assert.equal(await models.getAuth('openai'), undefined);
});

test('synchronous provider failures and truncated streams terminate with sanitized errors', async () => {
  const provider = anthropicProvider();
  const model = provider.getModels()[0];
  assert.ok(model);

  for (const [streamSimple, errorMessage] of [
    [
      () => {
        throw new Error('private-provider-detail');
      },
      'Model request failed',
    ],
    [
      () => {
        const stream = createAssistantMessageEventStream();
        stream.end();

        return stream;
      },
      'Model provider internal error',
    ],
  ] as const) {
    const safe = sanitizedProvider({ ...provider, streamSimple });
    const response = await safe.streamSimple(model, normalizeContext({ messages: [] })).result();
    assert.equal(response.stopReason, 'error');
    assert.equal(response.errorMessage, errorMessage);
    assert.equal(JSON.stringify(response).includes('private-provider-detail'), false);
  }
});

test('missing or blank keys do not authenticate and the store cannot be mutated', async () => {
  for (const ANTHROPIC_API_KEY of [undefined, '', '  ']) {
    const credentials = secretCredentials({ ANTHROPIC_API_KEY });
    assert.equal(await credentials.read('anthropic'), undefined);
    assert.deepEqual(await credentials.list(), []);
    assert.equal(await sessionModels({ ANTHROPIC_API_KEY }).getAuth('anthropic'), undefined);
  }

  const credentials = secretCredentials({ ANTHROPIC_API_KEY: 'private-key' });
  let called = false;
  await assert.rejects(
    credentials.modify('anthropic', async () => {
      called = true;

      return { type: 'api_key', key: 'replacement' };
    }),
    /read-only/,
  );
  assert.equal(called, false);
  await assert.rejects(credentials.delete('anthropic'), /read-only/);
  assert.deepEqual(await credentials.read('anthropic'), { type: 'api_key', key: 'private-key' });
});

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

      const database = await mf.unsafeGetDurableObjectStorage('cloud-swe-server', 'SessionThread', {
        name: session.id,
      });

      for (const table of ['pi_entries', 'pi_tasks', 'pi_submissions', 'pi_documents']) {
        assert.equal(JSON.stringify(await database.exec(`SELECT * FROM ${table}`)).includes('client-key-'), false);
      }
    } finally {
      await mf.dispose();
      await rm(storage, { recursive: true, force: true });
    }
  },
);

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
      assert.equal(ApiError.parse(await rejected.json()).error.code, 'model_unavailable');

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
