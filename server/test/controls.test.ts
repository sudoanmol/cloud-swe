import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { CancelRunResponse, ApiError, CreateSessionResponse, OperationReceipt, Session } from '@cloud-swe/protocol';
import { Response as WorkerResponse } from 'miniflare';

import { modelAnswer } from './model-answer.ts';
import { runtime } from './runtime.ts';

test(
  'native steering, FIFO follow-ups and run-targeted cancellation survive retries and restart',
  { timeout: 120_000 },
  async () => {
    const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-controls-'));
    const model = { provider: 'anthropic', id: 'claude-sonnet-5-5' };
    const bindings = { WORKSPACE_BACKEND: 'docker', MODEL_ID: model.id, ANTHROPIC_API_KEY: 'test-key' };
    const calls: Array<{ body: string; finish: () => void }> = [];

    const dev = {
      outboundService: {
        type: 'fetcher',
        handler: async (request) => {
          if (new URL(request.url).hostname !== 'api.anthropic.com') {
            assert.equal(new URL(request.url).hostname, 'sandbox');
            const response = await fetch(request.url, { method: request.method, headers: [...request.headers] });

            return new WorkerResponse(await response.arrayBuffer(), { status: response.status });
          }

          const body = await request.text();

          return new Promise<WorkerResponse>((resolve) => {
            const finish = () => resolve(modelAnswer(model.id));
            calls.push({ body, finish });
            request.signal.addEventListener('abort', finish, { once: true });
          });
        },
      },
    } satisfies NonNullable<Parameters<typeof runtime>[2]>;

    let mf = runtime(storage, bindings, dev);
    let base = await mf.ready;

    const request = (path: string, body?: Record<string, string>) =>
      fetch(new URL(path, base), {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer integration-test-personal-token', 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });

    try {
      const response = await fetch(new URL('/v1/sessions', base), {
        method: 'POST',
        headers: { Authorization: 'Bearer integration-test-personal-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          engine: 'pi',
          target: 'cloud',
          environment: 'base',
          model,
        }),
      });

      assert.equal(response.status, 201, await response.clone().text());
      const { session } = CreateSessionResponse.parse(await response.json());
      const path = `/v1/sessions/${session.id}`;
      const getSession = async () => Session.parse(await (await request(path)).json());

      const send = async (text: string, mode = 'reject') => {
        const operationId = crypto.randomUUID();
        const response = await request(path + '/messages', { operationId, text, mode });
        assert.equal(response.status, 202, await response.clone().text());

        return OperationReceipt.parse(await response.json());
      };

      const cancel = (receipt: OperationReceipt, operationId: string = crypto.randomUUID()) =>
        request(path + '/cancel', { operationId, runId: receipt.runId });

      async function call(index: number) {
        for (let attempt = 0; attempt < 300; attempt++) {
          const found = calls[index];

          if (found) return found;
          await setTimeout(10);
        }

        throw new Error('Expected model request ' + index);
      }

      assert.equal(session.capabilities.steerMessage, true);
      assert.equal(session.capabilities.queueMessage, true);
      assert.equal(session.capabilities.cancelRun, true);
      assert.equal((await request(path + '/cancel', { operationId: crypto.randomUUID() })).status, 400);

      const first = await send('first input');
      await call(0);
      const follow1 = await send('follow-up one', 'followUp');
      const follow2 = await send('follow-up two', 'followUp');
      const drop = await send('withdraw this queued input', 'followUp');
      const steer = await send('steer at the next boundary', 'steer');
      await send('second steer at the same boundary', 'steer');
      const active = await getSession();
      assert.deepEqual(active.run, { kind: 'running', runId: first.runId });
      assert.equal(active.pending.length, 6);
      assert.ok(active.pending.some((item) => item.operationId === steer.operationId && item.mode === 'steer'));
      assert.ok(active.pending.some((item) => item.operationId === follow1.operationId && item.status === 'queued'));

      const conflict = await request(path + '/messages', {
        operationId: steer.operationId,
        text: 'steer at the next boundary',
        mode: 'followUp',
      });

      assert.equal(conflict.status, 409);

      const cancelId = crypto.randomUUID();
      const withdrawn = await cancel(drop, cancelId);
      assert.equal(withdrawn.status, 202, await withdrawn.clone().text());
      const cancelReceipt = CancelRunResponse.parse(await withdrawn.json());
      assert.deepEqual(cancelReceipt.restoredMessages, [
        { operationId: drop.operationId, mode: 'followUp', text: 'withdraw this queued input' },
      ]);
      assert.deepEqual(CancelRunResponse.parse(await (await cancel(drop, cancelId)).json()), cancelReceipt);
      assert.deepEqual(
        CancelRunResponse.parse(await (await request(path + `/operations/${cancelId}`)).json()),
        cancelReceipt,
      );
      assert.deepEqual((await getSession()).run, { kind: 'running', runId: first.runId });
      assert.equal((await getSession()).pending.length, 5);
      assert.equal((await request(path + '/messages', { operationId: cancelId, text: 'wrong action' })).status, 409);
      assert.equal((await cancel(first, first.operationId)).status, 409);
      assert.equal((await cancel(first, cancelId)).status, 409);

      (await call(0)).finish();
      const secondCall = await call(1);
      assert.ok(secondCall.body.includes('steer at the next boundary'));
      assert.ok(secondCall.body.includes('second steer at the same boundary'), 'all steers enter at one boundary');
      assert.ok(secondCall.body.includes('follow-up one'));
      assert.equal(secondCall.body.includes('follow-up two'), false, 'one follow-up per native final boundary');
      assert.equal(secondCall.body.includes('withdraw this queued input'), false);
      secondCall.finish();
      await call(2);
      assert.ok(calls[2]?.body.includes('follow-up two'));

      const alsoWithdrawn = await send('queued behind active cancellation', 'followUp');
      const activeCancelId = crypto.randomUUID();
      const cancelled = await cancel(follow2, activeCancelId);
      assert.equal(cancelled.status, 202, await cancelled.clone().text());
      const activeCancellation = CancelRunResponse.parse(await cancelled.json());
      assert.deepEqual(activeCancellation.restoredMessages, [
        { operationId: alsoWithdrawn.operationId, mode: 'followUp', text: 'queued behind active cancellation' },
      ]);
      assert.equal((await getSession()).run.kind, 'cancelled');
      assert.deepEqual((await getSession()).pending, [], 'native active cancellation withdraws its follow-ups too');
      (await call(2)).finish();

      const successor = await send('successor input');
      await call(3);
      const stale = await cancel(follow2);
      assert.equal(stale.status, 409);
      assert.equal(ApiError.parse(await stale.json()).error.code, 'run_not_active');
      assert.equal((await cancel(follow2, activeCancelId)).status, 202, 'deduplication precedes stale-run checks');
      assert.deepEqual((await getSession()).run, { kind: 'running', runId: successor.runId });
      assert.equal((await cancel(alsoWithdrawn)).status, 409);
      assert.equal((await cancel(successor)).status, 202);
      (await call(3)).finish();
      assert.deepEqual((await getSession()).run, { kind: 'cancelled', runId: successor.runId });

      await mf.dispose();
      mf = runtime(storage, bindings, dev);
      base = await mf.ready;
      assert.deepEqual(
        CancelRunResponse.parse(await (await cancel(follow2, activeCancelId)).json()),
        activeCancellation,
      );
      assert.equal((await getSession()).run.kind, 'cancelled');
      assert.equal(calls.length, 4, 'restart and cancel retries launch no extra model requests');

      const bounded = [];

      for (let index = 0; index < 100; index++) bounded.push(await send('bounded queue ' + index, 'followUp'));
      const overflowId = crypto.randomUUID();

      const overflow = await request(path + '/messages', {
        operationId: overflowId,
        text: 'over capacity',
        mode: 'followUp',
      });

      assert.equal(overflow.status, 409);
      assert.equal((await request(path + `/operations/${overflowId}`)).status, 404);
      assert.equal((await getSession()).pending.length, 100);
      const head = bounded[0];
      assert.ok(head);
      await call(4);
      assert.equal((await cancel(head)).status, 202);
      (await call(4)).finish();
      assert.deepEqual((await getSession()).pending, []);
    } finally {
      for (const pending of calls) pending.finish();
      await mf.dispose();
      await rm(storage, { recursive: true, force: true });
    }
  },
);
