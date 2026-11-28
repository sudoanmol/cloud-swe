/**
 * Path: server/test/cut-requests.test.ts
 * Used by: pnpm test.
 * Purpose: A rewind removes the questions and secret requests still waiting that were filed in the part it cuts, sends no outcome they still owe, and leaves those filed above the cut as they were; a request being decided or delivered counts as work, which refuses a rewind.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { SubmitMessageRequest } from '@cloud-swe/protocol';

import { requestsWorking } from '../src/follow-ups.ts';
import { dropCutRequests } from '../src/sessions/cut-requests.ts';
import { deliverAnswers } from '../src/tools/questions.ts';
import { answerSecretRequest, deliverSecretAnswers } from '../src/tools/secret-requests.ts';
import { memoryStorage } from './fakes.ts';

const createdAt = '2026-11-17T08:00:00.000Z';
const decidedAt = '2026-11-17T08:05:00.000Z';

// One row of each kind, as the current code stores it, either waiting on the user or decided.
const kinds = {
  question: (id: string, decided: boolean) => ({
    question: {
      id,
      questions: [
        {
          question: 'Ship it?',
          header: 'Ship',
          options: [
            { label: 'Yes', description: 'Now' },
            { label: 'No', description: 'Later' },
          ],
          multiSelect: false,
        },
      ],
      createdAt,
      ...(decided ? { state: 'declined', decidedAt } : { state: 'pending' }),
    },
  }),
  secretRequest: (id: string, decided: boolean) => ({
    request: {
      id,
      environment: 'dev',
      name: 'OPENAI_API_KEY',
      hosts: ['api.openai.com'],
      header: 'Authorization',
      reason: 'Tests',
      createdAt,
      ...(decided ? { state: 'declined', decidedAt } : { state: 'pending' }),
    },
  }),
};

// The cut is before entry 10: a request filed when the newest entry was 10 or later was asked in the part it removes.
const BEFORE = 10;

// Each case and what the rewind leaves of it: the row unchanged, nothing, or the row marked delivered.
const cases = [
  { name: 'waiting, above the cut', decided: false, delivered: false, afterEntry: 9, left: 'unchanged' },
  { name: 'waiting, filed at the cut', decided: false, delivered: false, afterEntry: 10, left: 'nothing' },
  { name: 'decided and owed, above the cut', decided: true, delivered: false, afterEntry: 9, left: 'unchanged' },
  { name: 'decided and owed, in the cut', decided: true, delivered: false, afterEntry: 12, left: 'delivered' },
  { name: 'decided and delivered, in the cut', decided: true, delivered: true, afterEntry: 12, left: 'unchanged' },
  {
    name: 'decided and delivered, filed before afterEntry',
    decided: true,
    delivered: true,
    afterEntry: 0,
    left: 'unchanged',
  },
] as const;

const rows = Object.entries(kinds).flatMap(([kind, row]) =>
  cases.map((testCase, index) => {
    const id = `00000000-0000-4000-8000-00000000000${index}`;
    const { decided, delivered, afterEntry } = testCase;

    return { key: `${kind}:${id}`, row: { ...row(id, decided), delivered, afterEntry, version: 1 }, testCase };
  }),
);

/** The row as the rewind leaves it. */
const leftOf = ({ row, testCase }: (typeof rows)[number]) =>
  ({ unchanged: row, nothing: undefined, delivered: { ...row, delivered: true } })[testCase.left];

test('a rewind drops waiting requests filed at or after its entry and sends none of their outcomes', async () => {
  const storage = memoryStorage(new Map(rows.map(({ key, row }) => [key, row])));
  await dropCutRequests(storage, BEFORE);

  for (const entry of rows) assert.deepEqual(storage.rows.get(entry.key), leftOf(entry), entry.key);

  // Delivery afterwards sends only the outcome owed above the cut, once per kind.
  const sent: SubmitMessageRequest[] = [];

  const host = {
    storage,
    deliver: async (request: SubmitMessageRequest) => {
      sent.push(request);

      return true;
    },
    armDelivery: async () => {},
    changed: () => {},
  };

  for (const deliverAll of [deliverAnswers, deliverSecretAnswers]) {
    assert.equal(await deliverAll(host), false);
  }

  assert.equal(sent.length, 2);

  // Each was marked delivered as it was sent; every other row is as the rewind left it.
  for (const entry of rows) {
    const sentNow = entry.testCase.name === 'decided and owed, above the cut';
    assert.deepEqual(
      storage.rows.get(entry.key),
      sentNow ? { ...entry.row, delivered: true } : leftOf(entry),
      entry.key,
    );
  }

  // A second rewind at the same point changes nothing more.
  const settled = new Map(storage.rows);
  await dropCutRequests(storage, BEFORE);
  assert.deepEqual(storage.rows, settled);
});

test('a request being decided or delivered counts as work until it settles', async () => {
  const id = '00000000-0000-4000-8000-0000000000aa';

  const row = (kind: keyof typeof kinds, decided: boolean) => ({
    ...kinds[kind](id, decided),
    delivered: false,
    afterEntry: 3,
    version: 1,
  });

  /** A promise the test settles, and a second one that resolves when the code under test starts waiting on it. */
  const gate = <T>() => {
    let open = (_value: T) => {};
    let reached = () => {};

    const held = new Promise<T>((resolve) => {
      open = resolve;
    });

    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });

    return { open, waiting, wait: () => (reached(), held) };
  };

  // A secret being saved to the environment.
  const credentials = gate<object>();
  const saving = memoryStorage(new Map([[`secretRequest:${id}`, row('secretRequest', false)]]));
  const quiet = { deliver: async () => true, armDelivery: async () => {}, changed: () => {} };

  // SAFETY: the code under test calls only idFromName and get(...).setNetworkSecret on this namespace.
  const CREDENTIALS = { idFromName: () => 'personal', get: () => ({ setNetworkSecret: credentials.wait }) } as never;

  assert.equal(requestsWorking(saving), false);
  const answer = { value: 'dummy-key', hosts: ['api.openai.com'] };
  const decision = answerSecretRequest({ ...quiet, storage: saving, env: { CREDENTIALS } }, id, answer);
  await credentials.waiting;
  assert.equal(requestsWorking(saving), true);
  credentials.open({});
  assert.equal((await decision).status, 200);
  assert.equal(requestsWorking(saving), false);

  // An answer on its way to the agent.
  const admission = gate<boolean>();
  const delivering = memoryStorage(new Map([[`question:${id}`, row('question', true)]]));
  const delivery = deliverAnswers({ ...quiet, storage: delivering, deliver: admission.wait });
  await admission.waiting;
  assert.equal(requestsWorking(delivering), true);
  assert.equal(requestsWorking(saving), false, 'each Thread counts its own');
  admission.open(true);
  assert.equal(await delivery, false);
  assert.equal(requestsWorking(delivering), false);
});
