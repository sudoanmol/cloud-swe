import assert from 'node:assert/strict';
import test from 'node:test';

import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';

import { sanitizedProvider, secretCredentials, sessionModels } from '../src/sessions/models.ts';

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
