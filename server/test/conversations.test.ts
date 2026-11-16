/**
 * Path: server/test/conversations.test.ts
 * Used by: pnpm test.
 * Purpose: Conversations addressed by ID: unknown IDs, writes refused off the active conversation, reads of any, and runs, cancellations, history and cursors kept apart per conversation.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError, CancelRunResponse, HistoryResponse, OperationReceipt } from '@cloud-swe/protocol';

import { lifecycleRig } from './lifecycle-rig.ts';
import { modelAnswer } from './model-answer.ts';
import { model, waitFor } from './rig.ts';

const code = async (response: Response) => ApiError.parse(await response.json()).error.code;

test('a second conversation is addressed by its ID and kept apart from the first', { timeout: 60_000 }, async () => {
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

    // Nothing public creates a conversation yet; Pi forks one from the first.
    const second = await rig.fork(session.id);
    assert.notEqual(second, first);
    const forked = await rig.history(session.id, second);
    assert.equal(forked.entries.length, (await rig.history(session.id, first)).entries.length);

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
      ]) {
        assert.equal(response.status, 404);
        assert.equal(await code(response), 'conversation_not_found');
      }
    }

    // Writes go only to the active conversation; reads work on any.
    const inactive = rig.conversation(session.id, second);

    for (const response of [
      await rig.api(inactive + '/messages', { operationId: crypto.randomUUID(), text: 'not here' }),
      await rig.api(inactive + '/cancel', { operationId: crypto.randomUUID(), runId: receipt.runId }),
      await rig.api(inactive + '/compact', {}),
    ]) {
      assert.equal(response.status, 409);
      assert.equal(await code(response), 'conversation_not_active');
    }

    const before = await rig.snapshot(session.id, second);
    assert.equal(before.conversationId, second);
    const stream = await rig.events(session.id, second);
    assert.equal((await stream.next()).conversationId, second);
    await stream.close();

    // A cursor names its conversation.
    const page = HistoryResponse.parse(await (await rig.api(rig.conversation(session.id) + '/history?limit=1')).json());
    assert.ok(page.nextCursor);
    const cursor = '/history?limit=1&cursor=' + encodeURIComponent(page.nextCursor);
    assert.equal((await rig.api(rig.conversation(session.id) + cursor)).status, 200);
    const foreign = await rig.api(inactive + cursor);
    assert.equal(foreign.status, 400);
    assert.equal(await code(foreign), 'invalid_cursor');

    // A run in the first conversation is not live in the second.
    hold = new Promise((resolve) => {
      release = resolve;
    });

    const running = await rig.accepted(await rig.send(session.id, 'hold on'));
    await waitFor(
      () => rig.session(session.id),
      (current) => current.run.kind === 'running',
    );
    const elsewhere = await rig.snapshot(session.id, second);
    assert.equal(elsewhere.live.message, null);
    assert.deepEqual(elsewhere.live.tools, []);
    assert.deepEqual(
      elsewhere.history.entries.map(({ id }) => id),
      before.history.entries.map(({ id }) => id),
    );

    const cancel = { operationId: crypto.randomUUID(), runId: running.runId };
    const cancelled = await rig.api(rig.conversation(session.id) + '/cancel', cancel);
    assert.equal(cancelled.status, 202, await cancelled.clone().text());
    assert.equal(CancelRunResponse.parse(await cancelled.json()).conversationId, first);
    assert.equal((await rig.settled(session.id)).run.kind, 'cancelled');
    release();

    // Once the second is active, the session shows its run, not the first's cancelled one.
    await rig.activate(session.id, second);
    const moved = await rig.session(session.id);
    assert.equal(moved.activeConversationId, second);
    assert.equal(moved.run.kind, 'idle');

    const next = await rig.accepted(await rig.send(session.id, 'second conversation', undefined, undefined, second));
    assert.equal(next.conversationId, second);
    assert.equal((await rig.settled(session.id)).run.kind, 'completed');
    assert.ok((await rig.history(session.id, second)).entries.length > forked.entries.length);

    // The first now refuses new work, but a retry of what it admitted still gets its receipt, and only there.
    const refused = await rig.send(session.id, 'too late', undefined, undefined, first);
    assert.equal(await code(refused), 'conversation_not_active');
    assert.deepEqual(await rig.accepted(await rig.api(rig.conversation(session.id) + '/messages', message)), receipt);

    const replayed = await rig.api(inactive + '/messages', message);
    assert.equal(await code(replayed), 'operation_conflict');

    const cancelReplay = await rig.api(rig.conversation(session.id) + '/cancel', cancel);
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
});
