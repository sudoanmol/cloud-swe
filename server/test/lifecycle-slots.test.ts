import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError } from '@cloud-swe/protocol';

import { lifecycleRig } from './lifecycle-rig.ts';

test(
  'a refused create frees its slot at once, while one that may have made a sandbox keeps holding it',
  { timeout: 60_000 },
  async () => {
    const rig = await lifecycleRig({ MAX_SANDBOXES: '2' });

    try {
      let answer = 503;

      rig.setIntercept(({ method, path }) =>
        method === 'PUT' && /^\/workspaces\/[^/]+$/.test(path) ? new Response('no', { status: answer }) : undefined,
      );

      // A server error may follow a create that went through, so the slot stays reserved.
      const unclear = await rig.createResponse();
      assert.equal(ApiError.parse(await unclear.json()).error.code, 'sandbox_unreachable');

      // A 4xx proves nothing was created, so the slot is released.
      answer = 400;
      const refused = await rig.createResponse();
      assert.equal(refused.status, 503);
      assert.equal(ApiError.parse(await refused.json()).error.code, 'sandbox_refused');

      rig.setIntercept(() => undefined);
      await rig.create();
      const full = await rig.createResponse();
      assert.equal(full.status, 409, 'the unclear attempt still holds one slot, the new session the other');
      assert.equal(ApiError.parse(await full.json()).error.code, 'sandbox_limit_reached');
    } finally {
      await rig.close();
    }
  },
);
