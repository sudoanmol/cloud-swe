/**
 * Path: server/test/cut-requests.test.ts
 * Used by: pnpm test.
 * Purpose: A rewind removes the approvals, questions and secret requests still waiting that were filed in the part it cuts, sends no outcome they still owe, and leaves those filed above the cut as they were.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { SubmitMessageRequest } from '@cloud-swe/protocol';

import { deliverApprovals } from '../src/git/approvals.ts';
import { dropCutRequests } from '../src/sessions/cut-requests.ts';
import { deliverAnswers } from '../src/tools/questions.ts';
import { deliverSecretAnswers } from '../src/tools/secret-requests.ts';
import { memoryStorage } from './fakes.ts';

const createdAt = '2026-11-17T08:00:00.000Z';
const decidedAt = '2026-11-17T08:05:00.000Z';

// One row of each kind, as the current code stores it, either waiting on the user or decided.
const kinds = {
  approval: (id: string, decided: boolean) => ({
    approval: {
      id,
      repo: 'https://github.com/octo/hello',
      createdAt,
      kind: 'ref_change',
      ref: 'refs/heads/main',
      sha: 'a'.repeat(40),
      expected: null,
      ...(decided ? { state: 'rejected', result: 'Rejected by the user', decidedAt } : { state: 'pending' }),
    },
  }),
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

  for (const deliverAll of [deliverApprovals, deliverAnswers, deliverSecretAnswers]) {
    assert.equal(await deliverAll(host), false);
  }

  assert.equal(sent.length, 3);

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
