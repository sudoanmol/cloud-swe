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

import { ApiError, CreateSessionResponse, Session } from '@cloud-swe/protocol';
import { ModelCredentialStatus } from '@cloud-swe/protocol/credentials';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { Response as WorkerResponse } from 'miniflare';

import { sanitizedProvider, secretCredentials, sessionModels } from '../src/sessions/models.ts';
import { lifecycleRig } from './lifecycle-rig.ts';
import { modelAnswer } from './model-answer.ts';
import { headers, model, storedText, waitFor } from './rig.ts';
import { runtime, type RuntimeOptions } from './runtime.ts';

const noImages = async () => {
  throw new Error('No attachments in these tests');
};

test('Worker credentials resolve through real Pi auth without exposing secrets in metadata', async () => {
  const credentials = secretCredentials(async () => 'test-private-key');
  const models = sessionModels(async () => 'test-private-key', noImages);

  assert.deepEqual((await models.getAuth('anthropic'))?.auth, { apiKey: 'test-private-key' });
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
  for (const key of [undefined, '']) {
    const credentials = secretCredentials(async () => key);
    assert.equal(await credentials.read('anthropic'), undefined);
    assert.deepEqual(await credentials.list(), []);
    assert.equal(await sessionModels(async () => key, noImages).getAuth('anthropic'), undefined);
  }

  const credentials = secretCredentials(async () => 'private-key');
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
    const rig = await lifecycleRig({ ANTHROPIC_API_KEY: 'worker-test-fallback' });
    const seen: string[] = [];

    rig.setAnswer((_, request) => {
      seen.push(request.headers.get('x-api-key') ?? '');

      return modelAnswer(model.id);
    });

    const path = '/v1/credentials/models/anthropic';

    const request = (url: string, method = 'GET', body?: Record<string, string>) =>
      fetch(
        new URL(url, rig.base()),
        method === 'GET' ? { headers } : { method, headers, body: body ? JSON.stringify(body) : undefined },
      );

    const status = async () => ModelCredentialStatus.parse(await (await request(path)).json());

    try {
      assert.equal((await fetch(new URL(path, rig.base()))).status, 401);
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

      const session = await rig.create();
      const sessionPath = '/v1/sessions/' + session.id;
      const getSession = () => rig.session(session.id);

      const submit = () =>
        request(sessionPath + '/conversations/1/messages', 'POST', { operationId: crypto.randomUUID(), text: 'hello' });

      const settle = () => waitFor(getSession, (current) => current.run.kind === 'completed');

      assert.equal((await submit()).status, 202);
      await settle();
      assert.equal(seen[0], 'client-key-one');
      assert.equal((await request(path, 'PUT', { key: 'client-key-two' })).status, 200);
      assert.equal((await submit()).status, 202);
      await settle();
      assert.deepEqual(seen, ['client-key-one', 'client-key-two']);
      await rig.restart();
      assert.equal((await status()).source, 'client');
      assert.equal((await submit()).status, 202);
      await settle();
      assert.equal(seen[2], 'client-key-two');
      assert.equal((await request(path, 'DELETE')).status, 200);
      assert.equal((await status()).source, 'disabled');
      const refused = await submit();
      assert.equal(refused.status, 503);
      assert.equal(ApiError.parse(await refused.json()).error.code, 'model_unavailable');
      await rig.restart();
      assert.equal((await status()).source, 'disabled');
      assert.equal((await submit()).status, 503);
      assert.equal(seen.length, 3);

      assert.equal((await storedText(rig.storage)).includes('client-key-'), false);
    } finally {
      await rig.close();
    }
  },
);

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
    } satisfies NonNullable<RuntimeOptions['dev']>;

    const credentialsSwitch = {
      outboundService: { type: 'fetcher', handler: async () => new WorkerResponse(down ? 'down' : 'up') },
    } satisfies NonNullable<RuntimeOptions['dev']>;

    const mf = runtime(storage, {
      bindings: { WORKSPACE_BACKEND: 'docker', MODEL_ID: model.id },
      dev,
      credentialsSwitch,
    });

    try {
      const base = await mf.ready;

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
      const path = '/v1/sessions/' + CreateSessionResponse.parse(await created.json()).session.id;

      const send = (operationId: string) =>
        fetch(new URL(path + '/conversations/1/messages', base), {
          method: 'POST',
          headers,
          body: JSON.stringify({ operationId, text: 'hello' }),
        });

      assert.equal((await send(crypto.randomUUID())).status, 202);

      await waitFor(
        async () => modelRequests,
        (count) => count > 0,
      );
      down = true;

      const secondId = crypto.randomUUID();
      const rejected = await send(secondId);
      assert.equal(rejected.status, 503);
      assert.equal(ApiError.parse(await rejected.json()).error.code, 'model_unavailable');

      down = false;
      release?.();
      await waitFor(
        async () => Session.parse(await (await fetch(new URL(path, base), { headers })).json()),
        (current) => current.run.kind === 'completed',
      );
      // A reset would abandon the in-flight provider call and issue it again after recovery.
      assert.equal(modelRequests, 1);
      assert.equal((await send(secondId)).status, 202, 'the same operation is accepted once credentials return');
    } finally {
      await mf.dispose();
      await rm(storage, { recursive: true, force: true });
    }
  },
);
