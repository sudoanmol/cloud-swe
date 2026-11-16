/**
 * Path: server/test/controls.test.ts
 * Used by: pnpm test.
 * Purpose: Steering, follow-ups and run-targeted cancellation survive retries and restart.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CancelRunResponse, ApiError, OperationReceipt } from '@cloud-swe/protocol';
import type { Response as WorkerResponse } from 'miniflare';

import { lifecycleRig } from './lifecycle-rig.ts';
import { modelAnswer } from './model-answer.ts';
import { model, waitFor } from './rig.ts';

test(
  'native steering, FIFO follow-ups and run-targeted cancellation survive retries and restart',
  { timeout: 120_000 },
  async () => {
    const rig = await lifecycleRig();
    const calls: Array<{ body: string; finish: () => void }> = [];

    rig.setAnswer(
      (body, request) =>
        new Promise<WorkerResponse>((resolve) => {
          const finish = () => resolve(modelAnswer(model.id));
          calls.push({ body, finish });
          request.signal.addEventListener('abort', finish, { once: true });
        }),
    );

    const request = (path: string, body?: Record<string, string>) => rig.api(path, body);

    try {
      const session = await rig.create();
      const path = `/v1/sessions/${session.id}`;
      const getSession = () => rig.session(session.id);

      const send = async (text: string, mode = 'reject') => {
        const operationId = crypto.randomUUID();
        const response = await request(path + '/conversations/1/messages', { operationId, text, mode });
        assert.equal(response.status, 202, await response.clone().text());

        return OperationReceipt.parse(await response.json());
      };

      const cancel = (receipt: OperationReceipt, operationId: string = crypto.randomUUID()) =>
        request(path + '/conversations/1/cancel', { operationId, runId: receipt.runId });

      const call = (index: number) => waitFor(async () => calls[index]);

      assert.equal((await request(path + '/conversations/1/cancel', { operationId: crypto.randomUUID() })).status, 400);

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

      const conflict = await request(path + '/conversations/1/messages', {
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
        { operationId: drop.operationId, mode: 'followUp', text: 'withdraw this queued input', attachments: [] },
      ]);
      assert.deepEqual(CancelRunResponse.parse(await (await cancel(drop, cancelId)).json()), cancelReceipt);
      assert.deepEqual(
        CancelRunResponse.parse(await (await request(path + `/operations/${cancelId}`)).json()),
        cancelReceipt,
      );
      assert.deepEqual((await getSession()).run, { kind: 'running', runId: first.runId });
      assert.equal((await getSession()).pending.length, 5);
      assert.equal(
        (await request(path + '/conversations/1/messages', { operationId: cancelId, text: 'wrong action' })).status,
        409,
      );
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
        {
          operationId: alsoWithdrawn.operationId,
          mode: 'followUp',
          text: 'queued behind active cancellation',
          attachments: [],
        },
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

      await rig.restart();
      assert.deepEqual(
        CancelRunResponse.parse(await (await cancel(follow2, activeCancelId)).json()),
        activeCancellation,
      );
      assert.equal((await getSession()).run.kind, 'cancelled');
      assert.equal(calls.length, 4, 'restart and cancel retries launch no extra model requests');
    } finally {
      for (const pending of calls) pending.finish();
      await rig.close();
    }
  },
);
