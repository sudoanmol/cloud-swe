/**
 * Path: server/test/transcript.test.ts
 * Used by: pnpm test.
 * Purpose: History pagination, stable IDs and snapshot SSE survive reconnect and restart.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { HistoryResponse } from '@cloud-swe/protocol';

import type { sessionEvents } from './event-stream.ts';
import { lifecycleRig } from './lifecycle-rig.ts';
import { modelAnswer } from './model-answer.ts';
import { model } from './rig.ts';

test(
  'native history pagination, stable IDs and snapshot SSE reset survive reconnect and restart',
  { timeout: 30_000 },
  async () => {
    const rig = await lifecycleRig();
    const answer = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();

    rig.setAnswer(async () => {
      started.resolve();
      await answer.promise;

      return modelAnswer(model.id);
    });

    const streams: Awaited<ReturnType<typeof sessionEvents>>[] = [];

    try {
      const session = await rig.create();
      const path = '/v1/sessions/' + session.id;
      const get = (suffix: string) => rig.api(path + '/conversations/1' + suffix);

      const connect = async () => {
        const stream = await rig.events(session.id);
        streams.push(stream);

        return stream;
      };

      const stream = await connect();
      const initial = await stream.next();
      assert.equal(initial.session.id, session.id);
      assert.deepEqual(initial, await rig.snapshot(session.id));

      await rig.accepted(await rig.send(session.id, 'history input'));
      await stream.until((frame) => frame.session.run.kind === 'running');
      await stream.close();
      const reconnect = await connect();
      assert.equal(
        (await reconnect.next()).session.run.kind,
        'running',
        'disconnect does not cancel the accepted input',
      );
      await started.promise;
      answer.resolve();
      const frame = await reconnect.until((snapshot) => snapshot.session.run.kind === 'completed');
      assert.ok(frame.history.entries.some((entry) => entry.kind === 'message' && entry.role === 'assistant'));
      await reconnect.close();
      const full = await rig.history(session.id);
      assert.ok(full.entries.length >= 2);
      assert.ok(
        full.entries.every((entry) => /^[1-9][0-9]*$/.test(entry.id)),
        'Pi IDs are plain session-scoped strings',
      );
      const ids: string[] = [];
      let cursor: string | null = null;

      do {
        const response = await get('/history?limit=1' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
        assert.equal(response.status, 200);
        const page = HistoryResponse.parse(await response.json());
        ids.push(...page.entries.map(({ id }) => id));
        cursor = page.nextCursor;
      } while (cursor);

      assert.deepEqual(ids, full.entries.map(({ id }) => id).reverse());
      assert.equal((await get('/history?cursor=e30=')).status, 400);
      assert.equal((await get('/history?limit=0')).status, 400);
      const other = await rig.create();
      const firstPage = HistoryResponse.parse(await (await get('/history?limit=1')).json());
      assert.ok(firstPage.nextCursor);
      assert.equal(
        (
          await rig.api(
            '/v1/sessions/' + other.id + '/conversations/1/history?cursor=' + encodeURIComponent(firstPage.nextCursor),
          )
        ).status,
        400,
      );
      await rig.restart();
      assert.deepEqual(await rig.history(session.id), full);
      const restarted = await connect();
      assert.equal((await restarted.next()).session.run.kind, 'completed');
      await restarted.close();
    } finally {
      answer.resolve();

      for (const stream of streams) await stream.close().catch(() => {});
      await rig.close();
    }
  },
);
