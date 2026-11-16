/**
 * Path: server/test/model-errors.test.ts
 * Used by: pnpm test.
 * Purpose: Fixed failure messages keep Pi retry and overflow verdicts, and real generations never save provider text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunFailureCode, Session } from '@cloud-swe/protocol';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow';
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry';
import type { Response as WorkerResponse } from 'miniflare';

import { failureFromDetail, failureMessage } from '../src/sessions/failures.ts';
import { classifyProviderError } from '../src/sessions/models.ts';
import { lifecycleRig } from './lifecycle-rig.ts';
import { modelAnswer, providerError } from './model-answer.ts';
import { model, storedText, waitFor } from './rig.ts';

const secret = 'test-key-never-persist';
const rawDetail = 'raw-provider-detail-never-persist';

const samples: [string, RunFailureCode][] = [
  [`429 {"error":{"type":"rate_limit_error","message":"${rawDetail}"}}`, 'rate_limited'],
  [`529 {"error":{"type":"overloaded_error","message":"${rawDetail}"}}`, 'overloaded'],
  [`500 {"error":{"type":"api_error","message":"${rawDetail}"}}`, 'internal'],
  ['fetch failed', 'internal'],
  [`400 {"error":{"message":"prompt is too long: 213462 tokens > 200000 maximum"}}`, 'context_overflow'],
  ['413 {"error":{"type":"request_too_large"}}', 'context_overflow'],
  [`401 {"error":{"type":"authentication_error","message":"${rawDetail}"}}`, 'auth'],
  [`403 {"error":{"type":"permission_error","message":"${rawDetail}"}}`, 'auth'],
  ['400 Your credit balance is too low to access the Anthropic API', 'billing'],
  ['quota exceeded', 'billing'],
  [
    "This request was blocked under Anthropic's Usage Policy. To learn more, see the refusals and fallback docs.",
    'refused',
  ],
  ['The model refused to complete the request', 'refused'],
  ['Provider stopped with: sensitive', 'refused'],
  [`400 {"error":{"type":"invalid_request_error","message":"${rawDetail}"}}`, 'unknown'],
];

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

const failed = (errorMessage: string): AssistantMessage => ({
  role: 'assistant',
  api: 'anthropic-messages',
  provider: 'anthropic',
  model: model.id,
  content: [],
  stopReason: 'error',
  errorMessage,
  timestamp: 0,
  usage: { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

const verdict = (errorMessage: string) => ({
  overflow: isContextOverflow(failed(errorMessage)),
  retry: isRetryableAssistantError(failed(errorMessage)),
});

test('a fixed message keeps the verdicts Pi reached on the raw provider text', () => {
  for (const [raw, code] of samples) {
    assert.equal(classifyProviderError(failed(raw)), code, raw);
    const safe = failureMessage(code);
    assert.deepEqual(verdict(safe), verdict(raw), raw);
    assert.deepEqual(failureFromDetail(safe), { code, message: safe });
  }

  assert.deepEqual(failureFromDetail(`Compaction failed: ${failureMessage('auth')}`).code, 'auth');
  assert.deepEqual(failureFromDetail(rawDetail), { code: 'unknown', message: failureMessage('unknown') });
  assert.deepEqual(failureFromDetail(undefined).code, 'unknown');
});

test(
  'real generations retry, fail and report their code without saving provider text',
  { timeout: 90_000 },
  async () => {
    const rig = await lifecycleRig({ ANTHROPIC_API_KEY: secret });
    const answers: (() => WorkerResponse)[] = [];
    let calls = 0;

    rig.setAnswer(() => {
      calls++;

      return (answers.shift() ?? (() => modelAnswer(model.id)))();
    });

    try {
      const session = await rig.create();

      const submit = async () => {
        await rig.accepted(await rig.send(session.id, 'hello'));
      };

      const until = (done: (run: Session['run']) => boolean) =>
        waitFor(
          () => rig.session(session.id),
          (current) => done(current.run),
        );

      const settled = () => until((run) => run.kind === 'completed' || run.kind === 'failed');

      // A 429 retries through Pi, with exactly one HTTP request per Pi attempt, and then succeeds.
      answers.push(() => providerError(429, 'rate_limit_error', rawDetail));
      await submit();
      const retrying = await until((run) => run.kind === 'retrying');
      assert.equal(retrying.run.kind === 'retrying' && retrying.run.code, 'rate_limited');
      assert.ok(retrying.run.kind === 'retrying' && Date.parse(retrying.run.nextAttemptAt) > Date.now() - 5000);
      assert.equal((await settled()).run.kind, 'completed');
      assert.equal(calls, 2);

      // A 401 is not retried, and the client learns why.
      calls = 0;
      answers.push(() => providerError(401, 'authentication_error', rawDetail + secret));
      await submit();
      const denied = await settled();
      assert.equal(denied.run.kind === 'failed' && denied.run.code, 'auth');
      assert.equal(calls, 1);

      // A prompt-too-long with no earlier context to cut fails as an overflow rather than retrying.
      calls = 0;
      answers.push(() => providerError(400, 'invalid_request_error', 'prompt is too long: 3 tokens > 2 maximum'));
      await submit();
      const overflow = await settled();
      assert.equal(overflow.run.kind === 'failed' && overflow.run.code, 'context_overflow');
      assert.equal(calls, 1);

      const stored = await storedText(rig.storage);
      assert.equal(stored.includes(rawDetail), false);
      assert.equal(stored.includes(secret), false);

      const everything = await (await rig.api(`/v1/sessions/${session.id}/conversations/1/snapshot`)).text();
      assert.equal(everything.includes(rawDetail), false);
    } finally {
      await rig.close();
    }
  },
);
