/**
 * Path: server/test/secret-answer-race.test.ts
 * Used by: pnpm test.
 * Purpose: The first answer to a secret request wins even while its Credentials call is in flight: a racing decline waits, returns the same decision, and the outcome is delivered once.
 */

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

import { SecretRequest } from '@cloud-swe/protocol/environments';
import { StoredSecretRequest } from '@cloud-swe/protocol/storage';

import type { SecretAnswerHost } from '../src/tools/secret-requests.ts';

// The answer path never uses the sibling tool's text helper, whose imports require a Worker runtime.
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '../git/tools.ts' && context.parentURL?.endsWith('/tools/secret-requests.ts')) {
      return {
        url: 'data:text/javascript,export function text(){throw new Error("unused tool helper reached")}',
        shortCircuit: true,
      };
    }

    return next(specifier, context);
  },
});

const { answerSecretRequest, deliverSecretAnswers } = await import('../src/tools/secret-requests.ts');

hook.deregister();

function deferred() {
  let resolve = () => {};

  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

test('an answer racing an in-flight Credentials call returns the first decision', async () => {
  const request = SecretRequest.parse({
    id: crypto.randomUUID(),
    environment: 'dev',
    name: 'KEY',
    hosts: ['api.example.test'],
    header: 'Authorization',
    reason: 'Call the API',
    state: 'pending',
    createdAt: new Date().toISOString(),
  });

  const key = 'secretRequest:' + request.id;
  const rows = new Map<string, unknown>([[key, { request, delivered: false }]]);
  const entered = deferred();
  const release = deferred();
  const attempts: string[] = [];
  const admitted = new Map<string, string>();
  let keyWasStored = false;

  const host: SecretAnswerHost = {
    env: {
      // SAFETY: the function uses only these namespace/RPC methods. The delay models an in-flight RPC to another DO.
      CREDENTIALS: {
        idFromName: () => 'personal',
        get: () => ({
          setNetworkSecret: async () => {
            entered.resolve();
            await release.promise;
            keyWasStored = true;

            return {};
          },
        }),
      } as never,
    },
    // SAFETY: only these KV methods are used. Copying preserves real KV reads' isolation from later writes.
    storage: {
      get: async (name: string) => structuredClone(rows.get(name)),
      put: async <T>(name: string, value: T) => {
        rows.set(name, structuredClone(value));
      },
      list: async () => new Map(rows),
    } as never,
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

  const providing = answerSecretRequest(host, request.id, { value: 'review-dummy-key', hosts: request.hosts });
  await entered.promise;
  const declining = answerSecretRequest(host, request.id, { decline: true });
  release.resolve();
  const provided = SecretRequest.parse(await (await providing).json());
  const declined = SecretRequest.parse(await (await declining).json());

  assert.equal(provided.state, 'provided');
  assert.equal(declined.state, 'provided', 'the later decline returns the first decision');
  assert.equal(keyWasStored, true);
  assert.equal(StoredSecretRequest.parse(rows.get(key)).request.state, 'provided');
  assert.equal(StoredSecretRequest.parse(rows.get(key)).delivered, true);
  assert.equal(admitted.size, 1);
  assert.match(attempts[0] ?? '', /stored the network secret/);
  assert.equal(await deliverSecretAnswers(host), false, 'nothing is owed');
  assert.equal(JSON.stringify([...rows]).includes('review-dummy-key'), false);
});
