import assert from 'node:assert/strict';
import test from 'node:test';

import { secretCredentials, sessionModels } from '../src/sessions/credentials.ts';

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
