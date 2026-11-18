/**
 * Path: server/test/conversations.test.ts
 * Used by: pnpm test.
 * Purpose: Conversations addressed by ID: unknown IDs, writes refused off the active conversation after a rewind, reads of any, and runs, cancellations, history and cursors kept apart per conversation.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError, CancelRunResponse, HistoryResponse, OperationReceipt } from '@cloud-swe/protocol';

import { lifecycleRig } from './lifecycle-rig.ts';
import { modelAnswer } from './model-answer.ts';
import { model, waitFor } from './rig.ts';

const code = async (response: Response) => ApiError.parse(await response.json()).error.code;

test(
  'a rewound-from conversation is addressed by its ID and kept apart from the active one',
  { timeout: 60_000 },
  async () => {
    const rig = await lifecycleRig();
    let hold = Promise.resolve();
    let release = () => {};

    rig.setAnswer(async () => {
      await hold;

      return modelAnswer(model.id);
    });

    try {
      const session = await rig.create();
      const first = session.activeConversationId;
      assert.equal(first, '1');

      const message = { operationId: crypto.randomUUID(), text: 'first conversation' };
      const receipt = await rig.accepted(await rig.api(rig.conversation(session.id) + '/messages', message));
      assert.equal(receipt.conversationId, first);
      assert.equal((await rig.settled(session.id)).run.kind, 'completed');
      const kept = (await rig.history(session.id)).entries;

      // A run in the first conversation, cancelled.
      hold = new Promise((resolve) => {
        release = resolve;
      });

      const running = await rig.accepted(await rig.send(session.id, 'hold on'));
      await waitFor(
        () => rig.session(session.id),
        (current) => current.run.kind === 'running',
      );
      const cancel = { operationId: crypto.randomUUID(), runId: running.runId };
      const cancelled = await rig.api(rig.conversation(session.id) + '/cancel', cancel);
      assert.equal(cancelled.status, 202, await cancelled.clone().text());
      assert.equal(CancelRunResponse.parse(await cancelled.json()).conversationId, first);
      assert.equal((await rig.settled(session.id)).run.kind, 'cancelled');
      release();

      // Going back before the cancelled message makes a second conversation active; the session shows its run, not the
      // first's cancelled one.
      const cutAt = (await rig.history(session.id)).entries[kept.length]?.id;
      assert.ok(cutAt);
      const second = (await rig.rewind(session.id, cutAt)).conversationId;
      assert.notEqual(second, first);
      const moved = await rig.session(session.id);
      assert.equal(moved.activeConversationId, second);
      assert.equal(moved.run.kind, 'idle');
      assert.deepEqual(
        (await rig.history(session.id, second)).entries.map(({ id }) => id),
        kept.map(({ id }) => id),
      );

      // Unknown IDs, including another spelling of a real one, are 404 on every route.
      for (const unknown of ['999', '01', 'abc']) {
        const path = rig.conversation(session.id, unknown);
        const send = { operationId: crypto.randomUUID(), text: 'hello' };

        for (const response of [
          await rig.api(path + '/snapshot'),
          await rig.api(path + '/history'),
          await rig.api(path + '/events'),
          await rig.api(path + '/messages', send),
          await rig.api(path + '/cancel', { operationId: crypto.randomUUID(), runId: receipt.runId }),
          await rig.api(path + '/compact', {}),
          await rig.api(path + '/rewind', { operationId: crypto.randomUUID(), before: cutAt }),
        ]) {
          assert.equal(response.status, 404);
          assert.equal(await code(response), 'conversation_not_found');
        }
      }

      // Writes go only to the active conversation; reads work on any.
      const inactive = rig.conversation(session.id, first);

      for (const response of [
        await rig.api(inactive + '/messages', { operationId: crypto.randomUUID(), text: 'not here' }),
        await rig.api(inactive + '/cancel', { operationId: crypto.randomUUID(), runId: receipt.runId }),
        await rig.api(inactive + '/compact', {}),
      ]) {
        assert.equal(response.status, 409);
        assert.equal(await code(response), 'conversation_not_active');
      }

      const before = await rig.snapshot(session.id, first);
      assert.equal(before.conversationId, first);
      const stream = await rig.events(session.id, first);
      assert.equal((await stream.next()).conversationId, first);
      await stream.close();

      // A cursor names its conversation.
      const active = rig.conversation(session.id, second);
      const page = HistoryResponse.parse(await (await rig.api(active + '/history?limit=1')).json());
      assert.ok(page.nextCursor);
      const cursor = '/history?limit=1&cursor=' + encodeURIComponent(page.nextCursor);
      assert.equal((await rig.api(active + cursor)).status, 200);
      const foreign = await rig.api(inactive + cursor);
      assert.equal(foreign.status, 400);
      assert.equal(await code(foreign), 'invalid_cursor');

      // A run in the second conversation is not live in the first.
      hold = new Promise((resolve) => {
        release = resolve;
      });

      const next = await rig.accepted(await rig.send(session.id, 'second conversation', undefined, undefined, second));
      assert.equal(next.conversationId, second);
      await waitFor(
        () => rig.session(session.id),
        (current) => current.run.kind === 'running',
      );
      const elsewhere = await rig.snapshot(session.id, first);
      assert.equal(elsewhere.live.message, null);
      assert.deepEqual(elsewhere.live.tools, []);
      assert.deepEqual(
        elsewhere.history.entries.map(({ id }) => id),
        before.history.entries.map(({ id }) => id),
      );
      release();
      assert.equal((await rig.settled(session.id)).run.kind, 'completed');
      assert.ok((await rig.history(session.id, second)).entries.length > kept.length);

      // The first now refuses new work, but a retry of what it admitted still gets its receipt, and only there.
      const refused = await rig.send(session.id, 'too late', undefined, undefined, first);
      assert.equal(await code(refused), 'conversation_not_active');
      assert.deepEqual(await rig.accepted(await rig.api(inactive + '/messages', message)), receipt);

      const replayed = await rig.api(active + '/messages', message);
      assert.equal(await code(replayed), 'operation_conflict');

      const cancelReplay = await rig.api(inactive + '/cancel', cancel);
      assert.equal(cancelReplay.status, 202);

      // Receipts answer for any conversation and name it.
      for (const [operationId, conversationId] of [
        [receipt.operationId, first],
        [next.operationId, second],
      ] as const) {
        const response = await rig.api(`/v1/sessions/${session.id}/operations/${operationId}`);
        assert.equal(OperationReceipt.parse(await response.json()).conversationId, conversationId);
      }

      assert.equal((await rig.snapshot(session.id, first)).conversationId, first);
    } finally {
      release();
      await rig.close();
    }
  },
);
