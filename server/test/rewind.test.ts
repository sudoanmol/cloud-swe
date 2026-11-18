/**
 * Path: server/test/rewind.test.ts
 * Used by: pnpm test.
 * Purpose: Going back in a conversation over the public route: what the fork holds and what the model sees after it, cuts inside a tool round and past a compaction, retries and conflicts, refusals while not idle, one authority, the files-kept note, activity time and a restart.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError, type Entry, type Session } from '@cloud-swe/protocol';
import { z } from 'zod';

import { lifecycleRig } from './lifecycle-rig.ts';
import { modelAnswer } from './model-answer.ts';
import { toolResults } from './provider-request.ts';
import { model, waitFor } from './rig.ts';

type Rig = Awaited<ReturnType<typeof lifecycleRig>>;

const NOTE = 'Files and Git in the sandbox were not reverted';

const SUMMARY = 'SUMMARY-OF-EARLIER-WORK';

const code = async (response: Response) => ApiError.parse(await response.json()).error.code;

const ids = (entries: readonly Entry[]): string[] => entries.map(({ id }) => id);

/** The entries a cut before `id` keeps. */
const entriesAbove = (entries: readonly Entry[], id: string) =>
  entries.slice(
    0,
    entries.findIndex((entry) => entry.id === id),
  );

/** The ID of the user message whose text starts with `text`. */
function userEntry(entries: readonly Entry[], text: string): string {
  const found = entries.find(
    (entry) =>
      entry.kind === 'message' &&
      entry.role === 'user' &&
      entry.content.some((block) => 'text' in block && block.text.startsWith(text)),
  );

  assert.ok(found, `a user message "${text}"`);

  return found.id;
}

/** The answer's text, so a request can be checked for what the model said in a turn. */
const reply = (turn: number) => `REPLY-${turn}-END`;

/** A model whose answers wait on `hold` and are numbered; summaries wait on `summary`. */
function scripted(rig: Rig) {
  let turns = 0;
  const gates = { hold: Promise.resolve(), summary: Promise.resolve() };

  rig.setAnswer(async (body) => {
    if (body.includes('context summarization assistant')) {
      await gates.summary;

      return modelAnswer(model.id, [], { text: SUMMARY });
    }

    await gates.hold;

    return modelAnswer(model.id, [], { text: reply(++turns) });
  });

  return gates;
}

const ToolUses = z.object({
  messages: z.array(
    z.object({ content: z.union([z.string(), z.array(z.object({ type: z.string(), id: z.string().optional() }))]) }),
  ),
});

/** The IDs of every tool call in a model request. */
const toolCalls = (body: string) =>
  ToolUses.parse(JSON.parse(body)).messages.flatMap(({ content }) =>
    Array.isArray(content) ? content.flatMap((block) => (block.type === 'tool_use' && block.id ? [block.id] : [])) : [],
  );

test(
  'a rewind cuts the conversation, and the model continues from just above the cut',
  { timeout: 120_000 },
  async () => {
    const rig = await lifecycleRig();
    const gates = scripted(rig);
    let release = () => {};

    try {
      const session = await rig.create();
      const keep = await rig.accepted(await rig.send(session.id, 'KEEP-ONE'));
      await rig.settled(session.id);

      for (const text of ['CUT-TWO', 'CUT-THREE']) {
        await rig.accepted(await rig.send(session.id, text));
        await rig.settled(session.id);
      }

      const old = (await rig.history(session.id)).entries;
      const cutAt = userEntry(old, 'CUT-TWO');
      const above = entriesAbove(old, cutAt);

      // A cut in the middle: the fork holds exactly the entries above it, and the old conversation is unchanged.
      const request = { operationId: crypto.randomUUID(), before: cutAt };
      const receipt = await rig.rewind(session.id, cutAt, request.operationId);
      const fork = receipt.conversationId;
      assert.notEqual(fork, '1');
      assert.equal(receipt.sessionId, session.id);
      assert.equal(receipt.action, 'rewind_conversation');
      assert.deepEqual(ids((await rig.history(session.id, fork)).entries), ids(above));
      assert.deepEqual((await rig.history(session.id)).entries, old);

      const moved = await rig.session(session.id);
      assert.equal(moved.activeConversationId, fork);
      assert.equal(moved.run.kind, 'idle');
      assert.equal(moved.updatedAt, receipt.acceptedAt, 'going back counts as activity');

      // The model never sees the cut part, and a cut of plain chat adds no note.
      await rig.accepted(await rig.send(session.id, 'AFTER-FOUR', undefined, undefined, fork));
      assert.equal((await rig.settled(session.id)).run.kind, 'completed');
      const body = rig.bodies.at(-1) ?? '';

      for (const seen of ['KEEP-ONE', reply(1), 'AFTER-FOUR']) assert.ok(body.includes(seen), seen);

      for (const cut of ['CUT-TWO', 'CUT-THREE', reply(2), reply(3), NOTE])
        assert.equal(body.includes(cut), false, cut);

      // A retry returns the same receipt and cuts nothing more, also after a later message.
      const forkHistory = ids((await rig.history(session.id, fork)).entries);
      assert.deepEqual(await rig.rewind(session.id, cutAt, request.operationId), receipt);
      assert.equal((await rig.session(session.id)).activeConversationId, fork);
      assert.deepEqual(ids((await rig.history(session.id, fork)).entries), forkHistory);

      // Conflicts: the same ID with another entry; a message's ID for a rewind; a rewind's ID for a message and a cancel.
      for (const response of [
        await rig.rewindResponse(session.id, above[0]?.id ?? '', request.operationId),
        await rig.rewindResponse(session.id, forkHistory.at(-1) ?? '', keep.operationId, fork),
        await rig.send(session.id, 'reused', request.operationId, undefined, fork),
        await rig.api(rig.conversation(session.id, fork) + '/cancel', {
          operationId: request.operationId,
          runId: keep.runId,
        }),
      ]) {
        assert.equal(response.status, 409);
        assert.equal(await code(response), 'operation_conflict');
      }

      // The old conversation is no longer active; an unknown entry, a cut one and an unknown conversation are 404.
      const notActive = await rig.rewindResponse(session.id, cutAt);
      assert.equal(notActive.status, 409);
      assert.equal(await code(notActive), 'conversation_not_active');

      for (const [before, conversationId, expected] of [
        ['999999', fork, 'entry_not_found'],
        ['abc', fork, 'entry_not_found'],
        [cutAt, fork, 'entry_not_found'],
        [cutAt, '999', 'conversation_not_found'],
      ] as const) {
        const response = await rig.rewindResponse(session.id, before, undefined, conversationId);
        assert.equal(response.status, 404);
        assert.equal(await code(response), expected);
      }

      const malformed: Record<string, string>[] = [
        { operationId: crypto.randomUUID() },
        { operationId: crypto.randomUUID(), before: '' },
        { operationId: 'not-an-id', before: cutAt },
        { operationId: crypto.randomUUID(), before: cutAt, extra: 'no' },
      ];

      for (const body of malformed) {
        const response = await rig.api(rig.conversation(session.id, fork) + '/rewind', body);
        assert.equal(response.status, 400);
        assert.equal(await code(response), 'invalid_request');
      }

      // One authority: the old conversation refuses work, stays readable, and a run in the fork never shows in it.
      const oldPath = rig.conversation(session.id);

      for (const response of [
        await rig.send(session.id, 'not here'),
        await rig.api(oldPath + '/cancel', { operationId: crypto.randomUUID(), runId: keep.runId }),
        await rig.api(oldPath + '/compact', {}),
      ]) {
        assert.equal(response.status, 409);
        assert.equal(await code(response), 'conversation_not_active');
      }

      gates.hold = new Promise((resolve) => {
        release = resolve;
      });

      await rig.accepted(await rig.send(session.id, 'HOLD-FIVE', undefined, undefined, fork));
      await waitFor(
        () => rig.session(session.id),
        (current) => current.run.kind === 'running',
      );
      const oldSnapshot = await rig.snapshot(session.id);
      assert.equal(oldSnapshot.live.message, null);
      assert.deepEqual(oldSnapshot.live.tools, []);
      assert.deepEqual(ids(oldSnapshot.history.entries), ids(old));

      // Not idle: refused while running and with a queued message, and nothing changes.
      const runningCut = await rig.rewindResponse(session.id, forkHistory[0] ?? '', undefined, fork);
      assert.equal(runningCut.status, 409);
      assert.equal(await code(runningCut), 'session_not_idle');

      const queued = await rig.api(rig.conversation(session.id, fork) + '/messages', {
        operationId: crypto.randomUUID(),
        text: 'QUEUED-SIX',
        mode: 'followUp',
      });

      await rig.accepted(queued);
      await waitFor(
        () => rig.session(session.id),
        (current) => current.pending.some(({ status }) => status === 'queued'),
      );
      const queuedCut = await rig.rewindResponse(session.id, forkHistory[0] ?? '', undefined, fork);
      assert.equal(queuedCut.status, 409);
      assert.equal(await code(queuedCut), 'session_not_idle');
      assert.equal((await rig.session(session.id)).activeConversationId, fork);
      release();
      assert.equal((await rig.settled(session.id)).run.kind, 'completed');
      const afterRun = (await rig.history(session.id, fork)).entries;
      assert.ok(afterRun.length > forkHistory.length, 'the refused cuts removed nothing');

      // A cut before the latest user message.
      const latest = userEntry(afterRun, 'QUEUED-SIX');
      const second = await rig.rewind(session.id, latest, undefined, fork);
      assert.deepEqual(
        ids((await rig.history(session.id, second.conversationId)).entries),
        ids(entriesAbove(afterRun, latest)),
      );

      // A cut before the first entry leaves an empty conversation, where a message uses the same model.
      const first = (await rig.history(session.id, second.conversationId)).entries[0]?.id ?? '';
      const empty = await rig.rewind(session.id, first, undefined, second.conversationId);
      assert.deepEqual((await rig.history(session.id, empty.conversationId)).entries, []);
      assert.deepEqual((await rig.session(session.id)).model, session.model);
      await rig.accepted(await rig.send(session.id, 'FRESH-SEVEN', undefined, undefined, empty.conversationId));
      assert.equal((await rig.settled(session.id)).run.kind, 'completed');
      const fresh = z.object({ model: z.string() }).parse(JSON.parse(rig.bodies.at(-1) ?? ''));
      assert.equal(fresh.model, model.id);
      assert.equal((rig.bodies.at(-1) ?? '').includes('KEEP-ONE'), false);

      // A restart keeps the active conversation and the receipt replay.
      await rig.restart();
      assert.equal((await rig.session(session.id)).activeConversationId, empty.conversationId);
      assert.deepEqual(await rig.rewind(session.id, cutAt, request.operationId), receipt);
      assert.deepEqual(await rig.rewind(session.id, first, empty.operationId, second.conversationId), empty);
      assert.equal((await rig.session(session.id)).activeConversationId, empty.conversationId);
    } finally {
      release();
      await rig.close();
    }
  },
);

test(
  'a cut inside a tool round leaves a well-formed request and the files-kept note once',
  { timeout: 120_000 },
  async () => {
    const rig = await lifecycleRig();

    try {
      const session = await rig.create();
      await rig.accepted(await rig.send(session.id, 'Run it', undefined, rig.bash('printf tool-round')));
      assert.equal((await rig.settled(session.id)).run.kind, 'completed');

      const old = (await rig.history(session.id)).entries;
      const result = old.find((entry) => entry.kind === 'tool');
      assert.ok(result, 'the bash result');
      const { conversationId } = await rig.rewind(session.id, result.id);

      await rig.accepted(await rig.send(session.id, 'After the cut', undefined, undefined, conversationId));
      assert.equal((await rig.settled(session.id)).run.kind, 'completed');
      const body = rig.bodies.at(-1) ?? '';

      // Every tool call has a result: Pi fills in the one the cut removed.
      const calls = toolCalls(body);
      assert.equal(calls.length, 1);
      assert.deepEqual(
        toolResults(body).map(({ callId }) => callId),
        calls,
      );

      // The cut part ran bash: the model is told once that files were not reverted; no client sees the text.
      assert.equal(body.split(NOTE).length - 1, 1);
      assert.equal(JSON.stringify(await rig.snapshot(session.id, conversationId)).includes(NOTE), false);
    } finally {
      await rig.close();
    }
  },
);

test('a rewind is refused while a compaction runs, and can cut past a finished one', { timeout: 240_000 }, async () => {
  const rig = await lifecycleRig();
  const gates = scripted(rig);
  let release = () => {};

  try {
    const session = await rig.create();
    // Enough text that Pi finds an old prefix to summarize.
    const bulk = (label: string) => `${label} ` + 'lorem '.repeat(10_000);

    for (const label of ['BULK-ONE', 'BULK-TWO', 'BULK-THREE']) {
      await rig.accepted(await rig.send(session.id, bulk(label)));
      assert.equal((await rig.settled(session.id)).run.kind, 'completed');
    }

    gates.summary = new Promise((resolve) => {
      release = resolve;
    });

    assert.equal((await rig.api(rig.conversation(session.id) + '/compact', {})).status, 202);
    await waitFor(
      () => rig.session(session.id),
      (current: Session) => current.compaction !== null,
    );
    const before = ids((await rig.history(session.id)).entries);
    const cutAt = userEntry((await rig.history(session.id)).entries, 'BULK-TWO');
    const refused = await rig.rewindResponse(session.id, cutAt);
    assert.equal(refused.status, 409);
    assert.equal(await code(refused), 'session_not_idle');
    assert.equal((await rig.session(session.id)).activeConversationId, '1');

    release();
    await waitFor(
      () => rig.session(session.id),
      (current: Session) => current.compaction === null,
    );
    const compacted = (await rig.history(session.id)).entries;
    assert.ok(compacted.length > before.length, 'the summary is an entry');
    assert.ok(ids(compacted).includes(cutAt));

    // Cutting before an entry older than the summary: the next message runs on the context as it was there.
    const { conversationId } = await rig.rewind(session.id, cutAt);
    await rig.accepted(await rig.send(session.id, 'After the cut', undefined, undefined, conversationId));
    assert.equal((await rig.settled(session.id)).run.kind, 'completed');
    const body = rig.bodies.at(-1) ?? '';
    assert.ok(body.includes('BULK-ONE'));
    assert.equal(body.includes('BULK-TWO'), false);
    assert.equal(body.includes(SUMMARY), false);
  } finally {
    release();
    await rig.close();
  }
});
