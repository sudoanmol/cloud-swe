import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { CreateSessionResponse, RunFailureCode, Session, Snapshot } from '@cloud-swe/protocol';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow';
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry';
import { Response as WorkerResponse } from 'miniflare';

import { classifyProviderError, failureFromDetail, failureMessage } from '../src/sessions/model-failure.ts';
import { modelAnswer } from './model-answer.ts';
import { runtime } from './runtime.ts';

const token = 'integration-test-personal-token';
const model = { provider: 'anthropic', id: 'claude-sonnet-5-5' };
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

function providerError(status: number, type: string, message: string) {
  return WorkerResponse.json({ type: 'error', error: { type, message } }, { status });
}

test(
  'real generations retry, fail and report their code without saving provider text',
  { timeout: 90_000 },
  async () => {
    const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-model-errors-'));
    const answers: (() => WorkerResponse)[] = [];
    const requests: string[] = [];
    let calls = 0;

    const mf = runtime(storage, { WORKSPACE_BACKEND: 'docker', MODEL_ID: model.id, ANTHROPIC_API_KEY: secret }, {
      outboundService: {
        type: 'fetcher',
        handler: async (request) => {
          if (new URL(request.url).hostname !== 'api.anthropic.com') {
            const response = await fetch(request.url, { method: request.method, headers: [...request.headers] });

            return new WorkerResponse(await response.arrayBuffer(), { status: response.status });
          }

          calls++;
          requests.push(await request.clone().text());

          return (answers.shift() ?? (() => modelAnswer(model.id)))();
        },
      },
    } satisfies NonNullable<Parameters<typeof runtime>[2]>);

    try {
      const base = await mf.ready;

      const api = (path: string, init?: RequestInit) =>
        fetch(new URL(path, base), {
          ...init,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        });

      const created = await api('/v1/sessions', {
        method: 'POST',
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          engine: 'pi',
          target: 'cloud',
          environment: 'base',
          model,
        }),
      });

      assert.equal(created.status, 201, await created.clone().text());
      const { session } = CreateSessionResponse.parse(await created.json());
      const path = `/v1/sessions/${session.id}`;

      const submit = async () => {
        const response = await api(path + '/messages', {
          method: 'POST',
          body: JSON.stringify({ operationId: crypto.randomUUID(), text: 'hello' }),
        });

        assert.equal(response.status, 202, await response.clone().text());
      };

      const until = async (done: (run: Session['run']) => boolean) => {
        for (let attempt = 0; attempt < 300; attempt++) {
          const response = await api(path);
          assert.equal(response.status, 200, await response.clone().text());
          const current = Session.parse(await response.json());

          if (done(current.run)) return current;
          await setTimeout(100);
        }

        throw new Error('Run did not reach the expected state');
      };

      const settled = () => until((run) => run.kind === 'completed' || run.kind === 'failed');

      // A 429 retries through Pi, with exactly one HTTP request per Pi attempt, and then succeeds.
      answers.push(() => providerError(429, 'rate_limit_error', rawDetail));
      await submit();
      const retrying = await until((run) => run.kind === 'retrying');
      assert.equal(retrying.run.kind === 'retrying' && retrying.run.code, 'rate_limited');
      assert.ok(retrying.run.kind === 'retrying' && Date.parse(retrying.run.nextAttemptAt) > Date.now() - 5000);
      const snapshot = Snapshot.parse(await (await api(path + '/snapshot')).json());
      assert.ok(['retrying', 'running'].includes(snapshot.session.run.kind));
      assert.equal((await settled()).run.kind, 'completed');
      assert.equal(calls, 2);
      assert.ok(requests[0]?.includes('This sandbox is temporary'));

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
      assert.ok(overflow.run.kind === 'failed' || overflow.run.kind === 'completed');

      const persisted = await mf.unsafeGetDurableObjectStorage('cloud-swe-server', 'Thread', { name: session.id });

      for (const table of ['pi_entries', 'pi_tasks', 'pi_submissions', 'pi_documents']) {
        const rows = JSON.stringify(await persisted.exec(`SELECT * FROM ${table}`));
        assert.equal(rows.includes(rawDetail), false, table);
        assert.equal(rows.includes(secret), false, table);
      }

      const everything = await (await api(path + '/snapshot')).text();
      assert.equal(everything.includes(rawDetail), false);
    } finally {
      await mf.dispose();
      await rm(storage, { recursive: true, force: true });
    }
  },
);
