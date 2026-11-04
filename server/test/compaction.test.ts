/**
 * Path: server/test/compaction.test.ts
 * Used by: pnpm test.
 * Purpose: Pi compaction at the threshold, on overflow, on failure and across a restart.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { CreateSessionResponse, Session, Snapshot } from '@cloud-swe/protocol';
import { Response as WorkerResponse } from 'miniflare';

import { failureMessage } from '../src/sessions/models.ts';
import { modelAnswer } from './model-answer.ts';
import { runtime } from './runtime.ts';

const headers = { Authorization: 'Bearer integration-test-personal-token', 'Content-Type': 'application/json' };
const model = { provider: 'anthropic', id: 'claude-sonnet-5-5' };
const rawDetail = 'raw-provider-detail-never-persist';
const SUMMARY = 'SUMMARY-OF-EARLIER-WORK';

// Enough text that Pi finds an old prefix to summarize (it keeps the newest ~20k estimated tokens).
const bulk = (label: string) => `${label} ` + 'lorem '.repeat(10_000);

// Pi measures the context from the newest answer's usage; this is above our 500k usable window minus the 16k reserve.
const NEAR_FULL = 490_000;

type Kind = 'summary' | 'turn';

const providerError = (status: number, type: string, message: string) =>
  WorkerResponse.json({ type: 'error', error: { type, message } }, { status });

test(
  'Pi compacts at the threshold and on overflow, fails clearly without a cut, and recovers from a restart',
  { timeout: 240_000 },
  async () => {
    const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-compaction-'));
    const turns: string[] = [];
    let summaries = 0;
    let inputTokens = 3;

    const turn = () => modelAnswer(model.id, [], { inputTokens });
    const normal = (kind: Kind) => (kind === 'summary' ? modelAnswer(model.id, [], { text: SUMMARY }) : turn());
    let respond: (kind: Kind, body: string) => WorkerResponse | Promise<WorkerResponse> = normal;

    const bindings = { WORKSPACE_BACKEND: 'docker', MODEL_ID: model.id, ANTHROPIC_API_KEY: 'fake-key' };

    const dev = {
      outboundService: {
        type: 'fetcher',
        handler: async (request) => {
          if (new URL(request.url).hostname !== 'api.anthropic.com') {
            const response = await fetch(request.url, { method: request.method, headers: [...request.headers] });

            return new WorkerResponse(await response.arrayBuffer(), { status: response.status });
          }

          const body = await request.text();
          const kind = body.includes('context summarization assistant') ? 'summary' : 'turn';

          if (kind === 'summary') summaries++;
          else turns.push(body);

          return respond(kind, body);
        },
      },
    } satisfies NonNullable<Parameters<typeof runtime>[2]>;

    let mf = runtime(storage, bindings, dev);
    let base = await mf.ready;

    const api = (path: string, body?: Record<string, string | typeof model>) =>
      fetch(new URL(path, base), {
        method: body ? 'POST' : 'GET',
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

    const create = async () => {
      const created = await api('/v1/sessions', {
        operationId: crypto.randomUUID(),
        template: 'base',
        model,
      });

      assert.equal(created.status, 201, await created.clone().text());

      return '/v1/sessions/' + CreateSessionResponse.parse(await created.json()).session.id;
    };

    const state = async (path: string) => Session.parse(await (await api(path)).json());

    const until = async (path: string, done: (session: Session) => boolean) => {
      for (let attempt = 0; attempt < 600; attempt++) {
        const current = await state(path);

        if (done(current)) return current;
        await setTimeout(50);
      }

      throw new Error('Session did not reach the expected state');
    };

    const settled = (path: string) =>
      until(path, (s) => s.pending.length === 0 && ['completed', 'failed'].includes(s.run.kind));

    const send = async (path: string, text: string, mode: 'reject' | 'followUp' = 'reject') => {
      const response = await api(path + '/messages', { operationId: crypto.randomUUID(), text, mode });
      assert.equal(response.status, 202, await response.clone().text());
    };

    // Three large turns; the last answer reports a nearly full context when `full` is set.
    const fill = async (path: string, full: boolean) => {
      respond = normal;

      for (const label of ['one', 'two', 'three']) {
        inputTokens = full && label === 'three' ? NEAR_FULL : 3;
        await send(path, bulk(label));
        assert.equal((await settled(path)).run.kind, 'completed');
      }

      inputTokens = 3;
    };

    const reset = () => {
      turns.length = 0;
      summaries = 0;
    };

    try {
      // (a) Threshold: a blocking compaction runs before the next request, which then carries the summary.
      const threshold = await create();
      await fill(threshold, true);
      reset();
      respond = async (kind) => {
        if (kind === 'turn') return turn();
        await setTimeout(1500);

        return modelAnswer(model.id, [], { text: SUMMARY });
      };

      await send(threshold, 'after the threshold');
      const during = await until(threshold, (s) => s.compaction !== null);
      assert.deepEqual(
        {
          reason: during.compaction?.reason,
          blocking: during.compaction?.blocking,
          attempt: during.compaction?.attempt,
        },
        { reason: 'threshold', blocking: true, attempt: 1 },
      );

      const snapshot = Snapshot.parse(await (await api(threshold + '/snapshot')).json());
      assert.equal(snapshot.session.compaction?.reason, 'threshold');
      const done = await settled(threshold);
      assert.equal(done.run.kind, 'completed');
      assert.equal(done.compaction, null);
      assert.equal(done.compactionFailure, null);
      assert.equal(summaries, 1);
      assert.equal(turns.length, 1, 'the turn is requested once, after the summary');
      assert.match(turns[0] ?? '', new RegExp(SUMMARY));

      // (e) A failing summary fails the run with a safe code and records the failure, without provider text.
      await fill(threshold, true);
      reset();
      respond = (kind) => (kind === 'summary' ? providerError(401, 'authentication_error', rawDetail) : turn());
      await send(threshold, 'again after the threshold');
      const failed = await settled(threshold);
      assert.equal(failed.run.kind === 'failed' && failed.run.code, 'auth');
      assert.deepEqual(failed.compactionFailure, {
        reason: 'threshold',
        code: 'auth',
        message: failureMessage('auth'),
      });

      assert.equal(failed.compaction, null);
      assert.equal(turns.length, 0);

      // (b) Overflow with a cut compacts and retries once, then succeeds.
      const overflow = await create();
      await fill(overflow, false);
      reset();
      let overflowed = false;
      respond = (kind) => {
        if (kind === 'summary') return modelAnswer(model.id, [], { text: SUMMARY });

        if (overflowed) return turn();
        overflowed = true;

        return providerError(400, 'invalid_request_error', 'prompt is too long: 1100000 tokens > 1000000 maximum');
      };

      await send(overflow, 'overflow once');
      const recovered = await settled(overflow);
      assert.equal(recovered.run.kind, 'completed');
      assert.equal(summaries, 1);
      assert.equal(turns.length, 2);
      assert.match(turns[1] ?? '', new RegExp(SUMMARY));
      assert.equal(recovered.compactionFailure, null);

      // (c) Overflow with nothing to cut fails as a context overflow and never summarizes.
      const empty = await create();
      reset();
      respond = (kind) =>
        kind === 'summary'
          ? modelAnswer(model.id, [], { text: SUMMARY })
          : providerError(
              400,
              'invalid_request_error',
              `prompt is too long: 1100000 tokens > 1000000 maximum ${rawDetail}`,
            );

      await send(empty, 'too big from the start');
      const uncut = await settled(empty);
      assert.equal(uncut.run.kind === 'failed' && uncut.run.code, 'context_overflow');
      assert.equal(summaries, 0);
      assert.equal(turns.length, 1);

      // (d) A restart during a blocking compaction recovers, and a queued follow-up still runs.
      const restart = await create();
      await fill(restart, true);
      reset();
      let release = (_response: WorkerResponse) => {};
      const hung = new Promise<WorkerResponse>((resolve) => (release = resolve));
      respond = (kind) => (kind === 'summary' ? hung : turn());

      await send(restart, bulk('MARK-A'));
      await until(restart, (s) => s.compaction !== null);
      await send(restart, 'MARK-B', 'followUp');
      assert.equal((await state(restart)).pending.length, 2);

      await mf.dispose();
      release(new WorkerResponse('stopped', { status: 503 }));
      reset();
      respond = (kind) => (kind === 'summary' ? modelAnswer(model.id, [], { text: SUMMARY }) : turn());
      mf = runtime(storage, bindings, dev);
      base = await mf.ready;

      const resumed = await settled(restart);
      assert.equal(resumed.run.kind, 'completed');
      assert.equal(resumed.compaction, null);
      assert.equal(resumed.compactionFailure, null);
      assert.match(turns.join('\n'), /MARK-B/);
      assert.match(turns.at(-1) ?? '', new RegExp(SUMMARY));

      // The client can compact by hand, with instructions.
      summaries = 0;
      const summaryBodies: string[] = [];
      respond = (kind, body) => {
        if (kind === 'summary') summaryBodies.push(body);

        return normal(kind);
      };

      assert.equal((await api(`${threshold}/compact`, { instructions: '' })).status, 400);
      assert.equal((await api(`${threshold}/compact`, { instructions: 'Keep MARK-MANUAL' })).status, 202);

      for (let attempt = 0; attempt < 100 && summaries === 0; attempt++) await setTimeout(100);
      assert.equal(summaries, 1, 'the manual compaction reached the model');
      assert.match(summaryBodies.at(-1) ?? '', /Keep MARK-MANUAL/);

      // Nothing the provider said, or the key, is saved.
      const persisted = await mf.unsafeGetDurableObjectStorage('cloud-swe-server', 'SessionThreadV2', {
        name: threshold.split('/').at(-1) ?? '',
      });

      for (const table of ['pi_entries', 'pi_tasks', 'pi_submissions', 'pi_documents'])
        assert.equal(JSON.stringify(await persisted.exec(`SELECT * FROM ${table}`)).includes(rawDetail), false, table);
    } finally {
      await mf.dispose();
      await rm(storage, { recursive: true, force: true });
    }
  },
);
