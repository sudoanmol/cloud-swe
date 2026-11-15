/**
 * Path: server/test/secret-answer-race.test.ts
 * Used by: pnpm test.
 * Purpose: A secret request's outcome is delivered once: the first answer wins even while its Credentials call is in flight, and a delivered outcome is marked so nothing re-sends it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { SecretRequest } from '@cloud-swe/protocol/environments';
import { StoredSecretRequest } from '@cloud-swe/protocol/storage';

import { answerSecretRequest, deliverSecretAnswers, type SecretAnswerHost } from '../src/tools/secret-requests.ts';
import { memoryStorage } from './fakes.ts';

function pendingRequest() {
  return SecretRequest.parse({
    id: crypto.randomUUID(),
    environment: 'dev',
    name: 'KEY',
    hosts: ['api.example.test'],
    header: 'Authorization',
    reason: 'Call the API',
    state: 'pending',
    createdAt: new Date().toISOString(),
  });
}

/** A session holding one pending request, whose Credentials call waits for `storeKey`, and which admits messages. */
async function secretHost(request: SecretRequest, storeKey: () => Promise<void> = async () => {}) {
  const storage = memoryStorage();
  await storage.put('secretRequest:' + request.id, StoredSecretRequest.parse({ request, delivered: false }));
  const attempts: string[] = [];
  const admitted = new Map<string, string>();

  const host: SecretAnswerHost = {
    env: {
      // SAFETY: the code under test calls only idFromName and get(...).setNetworkSecret on this namespace.
      CREDENTIALS: {
        idFromName: () => 'personal',
        get: () => ({
          setNetworkSecret: async () => {
            await storeKey();

            return {};
          },
        }),
      } as never,
    },
    storage,
    deliver: async ({ operationId, text }) => {
      attempts.push(text);
      const previous = admitted.get(operationId);

      // Normal message admission rejects reuse of an operation ID for different text.
      if (previous !== undefined && previous !== text) return false;
      admitted.set(operationId, text);

      return true;
    },
    armDelivery: async () => {},
    changed: () => {},
  };

  const stored = () => StoredSecretRequest.parse(storage.rows.get('secretRequest:' + request.id));

  return { host, storage, attempts, admitted, stored };
}

test('an answer racing an in-flight Credentials call returns the first decision', async () => {
  const request = pendingRequest();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let keyWasStored = false;

  const { host, storage, attempts, admitted, stored } = await secretHost(request, async () => {
    entered.resolve();
    await release.promise;
    keyWasStored = true;
  });

  const providing = answerSecretRequest(host, request.id, { value: 'review-dummy-key', hosts: request.hosts });
  await entered.promise;
  const declining = answerSecretRequest(host, request.id, { decline: true });
  release.resolve();
  const provided = SecretRequest.parse(await (await providing).json());
  const declined = SecretRequest.parse(await (await declining).json());

  assert.equal(provided.state, 'provided');
  assert.equal(declined.state, 'provided', 'the later decline returns the first decision');
  assert.equal(keyWasStored, true);
  assert.equal(stored().request.state, 'provided');
  assert.equal(stored().delivered, true);
  assert.equal(admitted.size, 1);
  assert.match(attempts[0] ?? '', /stored the network secret/);
  assert.equal(await deliverSecretAnswers(host), false, 'nothing is owed');
  assert.equal(JSON.stringify([...storage.rows]).includes('review-dummy-key'), false);
});

test('a provided answer is marked delivered once admitted, so the delivery job sends nothing more', async () => {
  const request = pendingRequest();
  const { host, attempts, stored } = await secretHost(request);

  const answered = await answerSecretRequest(host, request.id, { value: 'dummy-key', hosts: request.hosts });
  assert.equal(SecretRequest.parse(await answered.json()).state, 'provided');
  assert.deepEqual(stored().request.confirmedHosts, request.hosts);
  assert.equal(stored().delivered, true);
  assert.equal(attempts.length, 1);

  assert.equal(await deliverSecretAnswers(host), false);
  assert.equal(attempts.length, 1, 'the delivery job re-sent nothing');
});
