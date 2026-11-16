/**
 * Path: server/test/queue-full.test.ts
 * Used by: pnpm test.
 * Purpose: A full input queue is refused as input_queue_full, not as a settling session, and a cancel withdraws all of it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError, CancelRunResponse } from '@cloud-swe/protocol';

import { lifecycleRig } from './lifecycle-rig.ts';

test(
  'a full input queue is refused as input_queue_full, and a cancel withdraws all of it',
  { timeout: 120_000 },
  async () => {
    const rig = await lifecycleRig();

    try {
      const session = await rig.create();
      const busy = await rig.accepted(await rig.send(session.id, 'busy', undefined, rig.bash('sleep 60')));

      let refused: Response | undefined;
      let operationId = '';
      let queued = 0;

      while (!refused && queued < 120) {
        operationId = crypto.randomUUID();

        const response = await rig.api(`/v1/sessions/${session.id}/messages`, {
          operationId,
          text: `queued ${queued}`,
          mode: 'followUp',
        });

        if (response.status === 202) queued++;
        else refused = response;
      }

      assert.ok(refused, 'the queue has a limit');
      assert.equal(refused.status, 409);
      assert.equal(ApiError.parse(await refused.json()).error.code, 'input_queue_full');
      assert.equal((await rig.session(session.id)).pending.length, 100);
      assert.equal(
        (await rig.api(`/v1/sessions/${session.id}/operations/${operationId}`)).status,
        404,
        'nothing was admitted',
      );

      const cancelled = await rig.api(`/v1/sessions/${session.id}/cancel`, {
        operationId: crypto.randomUUID(),
        runId: busy.runId,
      });

      assert.equal(cancelled.status, 202, await cancelled.clone().text());
      assert.equal(CancelRunResponse.parse(await cancelled.json()).restoredMessages.length, queued);
      assert.deepEqual((await rig.session(session.id)).pending, []);
    } finally {
      await rig.close();
    }
  },
);
