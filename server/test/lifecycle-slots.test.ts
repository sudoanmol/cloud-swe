import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { ApiError } from '@cloud-swe/protocol';

import { lifecycleRig } from './lifecycle-rig.ts';

const limitCode = async (response: Response) => ApiError.parse(await response.json()).error.code;

test(
  'a sandbox being resumed keeps its slot even while Boat still reads it as stopped, and ends the resume running',
  { timeout: 60_000 },
  async () => {
    const rig = await lifecycleRig({ MAX_SANDBOXES: '2' });

    try {
      const a = await rig.create();
      await rig.create();
      await rig.sandbox(a.workspace.id, '/stop', '{}');
      let hold = false;

      // Right after a resume Boat may still read `stopped`.
      rig.setIntercept(({ method, path }) =>
        hold && method === 'GET' && path === `/workspaces/${a.workspace.id}`
          ? Response.json({
              provider: 'docker',
              id: a.workspace.id,
              state: 'stopped',
              root: `/workspace/${a.workspace.id}`,
            })
          : undefined,
      );

      hold = true;
      const resuming = rig.send(a.id, 'wake up');
      await rig.until(
        async () => rig.requests('POST', /\/resume$/).length,
        (count) => count >= 1,
      );

      const during = await rig.createResponse();
      assert.equal(during.status, 409, 'the resuming sandbox still counts');
      assert.equal(await limitCode(during), 'sandbox_limit_reached');

      hold = false;
      await rig.accepted(await resuming);
      assert.equal((await rig.session(a.id)).workspace.state, 'running');
      const after = await rig.createResponse();
      assert.equal(after.status, 409, 'and it is stored as running once the resume is done');
    } finally {
      await rig.close();
    }
  },
);

test(
  'the idle sweep decides on each sandbox as it is now, not as it was when the sweep began',
  { timeout: 60_000 },
  async () => {
    const rig = await lifecycleRig({ SANDBOX_DELETE_AFTER_DAYS: '0.0000231' });

    try {
      const a = await rig.create();
      const b = await rig.create();
      await rig.accepted(await rig.send(a.id, 'still here'));

      // Both are idle past the limit when the sweep runs. Its first delete is slow, and the other session wakes up meanwhile.
      let first: string | undefined;

      rig.setIntercept(async ({ method, path }) => {
        if (method !== 'DELETE' || first) return undefined;
        first = /^\/workspaces\/([^/]+)$/.exec(path)?.[1];
        await setTimeout(1000);
      });

      const deleting = await rig.until(
        async () => first,
        (id) => id !== undefined,
        400,
      );

      const survivor = deleting === a.workspace.id ? b : a;
      await rig.accepted(await rig.send(survivor.id, 'me too'));

      assert.equal(
        await rig.until(
          () => rig.boxState(deleting ?? ''),
          (state) => state === 'deleted',
          200,
        ),
        'deleted',
      );

      await setTimeout(500);
      assert.equal(await rig.boxState(survivor.workspace.id), 'running', 'activity during the sweep saved it');
    } finally {
      await rig.close();
    }
  },
);

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
