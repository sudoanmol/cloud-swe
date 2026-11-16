/**
 * Path: server/test/delta-stream.test.ts
 * Used by: pnpm test.
 * Purpose: Over a real SSE connection, the stream sends a snapshot and then only changes that rebuild it, resumes by entry ID, resets with a snapshot, and reads sandbox state only on the heartbeat.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { HistoryResponse, type Snapshot } from '@cloud-swe/protocol';
import { z } from 'zod';

import { type Held, sameState, sessionEvents } from './event-stream.ts';
import { lifecycleRig } from './lifecycle-rig.ts';
import { modelAnswer, streamedAnswer } from './model-answer.ts';
import { type Call, commandIdentity, headers, model, waitFor } from './rig.ts';

type Rig = Awaited<ReturnType<typeof lifecycleRig>>;

type Stream = Awaited<ReturnType<typeof sessionEvents>>;

/** Reads events until what the client built from them equals the server's own snapshot. */
async function converge(stream: Stream, server: () => Promise<Snapshot>) {
  for (;;) {
    const expected = await server();

    if (sameState(stream.held().snapshot, expected)) return expected;
    await stream.next();
  }
}

/** Connects to a conversation's events, resuming with a `Last-Event-ID` header and/or a `?after=` query. */
function connect(rig: Rig, sessionId: string, options: { header?: string; after?: string; held?: Held; cid?: string }) {
  const url = new URL(rig.conversation(sessionId, options.cid) + '/events', rig.base());

  if (options.after !== undefined) url.searchParams.set('after', options.after);

  return sessionEvents(
    url,
    options.header === undefined ? headers : { ...headers, 'Last-Event-ID': options.header },
    options.held,
  );
}

async function firstKinds(stream: Stream, count: number) {
  const kinds: string[] = [];

  for (let index = 0; index < count; index++) kinds.push((await stream.read()).event.kind);
  await stream.close();

  return kinds;
}

const calls = async (rig: Rig, sessionId: string) =>
  z
    .record(z.string(), z.number())
    .parse(await (await fetch(new URL(`/test/sessions/${sessionId}/calls`, rig.base()))).json());

const callsTo = (counts: Record<string, number>, prefix: string) =>
  Object.entries(counts)
    .filter(([method]) => method.startsWith(prefix))
    .reduce((sum, [, count]) => sum + count, 0);

test('a snapshot, then deltas that rebuild it, and resume by entry ID', { timeout: 120_000 }, async () => {
  const rig = await lifecycleRig();

  try {
    const session = await rig.create();
    const stream = await connect(rig, session.id, {});
    const first = await stream.read();
    assert.equal(first.event.kind, 'snapshot');
    assert.notEqual(first.id, undefined, 'the snapshot sets an SSE id');

    await rig.accepted(await rig.send(session.id, 'Run a command', undefined, rig.bash('printf delta-output')));
    assert.equal((await rig.settled(session.id)).run.kind, 'completed');
    const expected = await converge(stream, () => rig.snapshot(session.id));
    await stream.close();

    const later = stream.received.slice(1).map(({ event }) => event.kind);
    assert.deepEqual([...new Set(later)].sort(), ['entries', 'live', 'session'], 'no second snapshot');

    for (const { event, id } of stream.received) {
      assert.equal(id !== undefined, event.kind === 'snapshot' || event.kind === 'entries', `${event.kind} id: ${id}`);
    }

    const ids: string[] = expected.history.entries.map((entry) => entry.id);
    const [mid, newest] = [ids[1], ids.at(-1)];
    assert.ok(mid && newest && ids.length >= 4, `entries ${ids.join(',')}`);

    const upTo = (id: string): Held => ({
      snapshot: {
        ...expected,
        history: { ...expected.history, entries: expected.history.entries.slice(0, ids.indexOf(id) + 1) },
      },
      lastId: id,
    });

    // Mid-transcript: session, the entries after it, live; the client then holds exactly the server's snapshot.
    for (const options of [{ header: mid }, { after: mid }]) {
      const resumed = await connect(rig, session.id, { ...options, held: upTo(mid) });
      const events = [await resumed.read(), await resumed.read(), await resumed.read()];
      await resumed.close();
      assert.deepEqual(
        events.map(({ event }) => event.kind),
        ['session', 'entries', 'live'],
      );
      assert.equal(events[1]?.id, newest);
      assert.deepEqual(events[2]?.state, expected);
    }

    // At the newest entry there is nothing to send; the header wins over the query.
    assert.deepEqual(await firstKinds(await connect(rig, session.id, { header: newest, held: upTo(newest) }), 2), [
      'session',
      'live',
    ]);
    assert.deepEqual(
      await firstKinds(await connect(rig, session.id, { header: newest, after: mid, held: upTo(newest) }), 2),
      ['session', 'live'],
    );
    assert.deepEqual(await firstKinds(await connect(rig, session.id, { header: '999999' }), 1), ['snapshot']);
    assert.deepEqual(await firstKinds(await connect(rig, session.id, { header: 'not-an-id', after: mid }), 1), [
      'snapshot',
    ]);
    const invalid = await rig.api(rig.conversation(session.id) + '/events?after=');
    assert.equal(invalid.status, 400);

    // An entry of another conversation: the fork lacks what the first conversation commits after it.
    const fork = await rig.fork(session.id);
    await rig.accepted(await rig.send(session.id, 'After the fork'));
    await rig.settled(session.id);
    const parentNewest = (await rig.snapshot(session.id)).history.entries.at(-1)?.id;
    assert.deepEqual(await firstKinds(await connect(rig, session.id, { cid: fork, header: parentNewest }), 1), [
      'snapshot',
    ]);
  } finally {
    await rig.close();
  }
});

test('more than a page of new entries resets a resume to a snapshot', { timeout: 120_000 }, async () => {
  const rig = await lifecycleRig();

  // One answer with a page of tool calls that fail validation at once, then a plain answer.
  const fanOut: Call[] = Array.from({ length: 101 }, (_, index) => ({
    id: `todo-${index}`,
    name: 'todo',
    arguments: {},
  }));

  let answered = 0;
  rig.setAnswer(() => modelAnswer(model.id, answered++ === 0 ? fanOut : []));

  try {
    const session = await rig.create();
    const watching = await connect(rig, session.id, {});
    await watching.read();
    const before = (await rig.snapshot(session.id)).history.entries.at(-1)?.id ?? null;

    await rig.accepted(await rig.send(session.id, 'Fan out'));
    assert.equal((await rig.settled(session.id)).run.kind, 'completed');
    await converge(watching, () => rig.snapshot(session.id));
    await watching.close();

    // The snapshot holds a page; the page before it comes from history.
    const newestPage = await rig.history(session.id);
    assert.ok(newestPage.nextCursor);

    const olderPage = await rig.api(
      `${rig.conversation(session.id)}/history?limit=100&cursor=${encodeURIComponent(newestPage.nextCursor)}`,
    );

    const ids = [...HistoryResponse.parse(await olderPage.json()).entries, ...newestPage.entries].map(
      (entry) => entry.id,
    );

    const pageBehind = ids.at(-1 - 100);
    assert.ok(pageBehind, `${ids.length} entries`);
    assert.deepEqual(
      await firstKinds(
        await connect(rig, session.id, {
          header: pageBehind,
          held: { snapshot: await rig.snapshot(session.id), lastId: pageBehind },
        }),
        3,
      ),
      ['session', 'entries', 'live'],
    );
    const tooFar = ids.at(-1 - 101) ?? before;
    assert.ok(tooFar);
    assert.deepEqual(await firstKinds(await connect(rig, session.id, { header: tooFar }), 1), ['snapshot']);
  } finally {
    await rig.close();
  }
});

test('compaction resets the stream with a snapshot that matches the server', { timeout: 120_000 }, async () => {
  const rig = await lifecycleRig();

  rig.setAnswer((body) =>
    modelAnswer(model.id, [], { text: body.includes('context summarization assistant') ? 'SUMMARY' : 'ok' }),
  );

  try {
    const session = await rig.create();

    for (const label of ['one', 'two', 'three']) {
      await rig.accepted(await rig.send(session.id, `${label} ` + 'lorem '.repeat(10_000)));
      assert.equal((await rig.settled(session.id)).run.kind, 'completed');
    }

    const stream = await connect(rig, session.id, {});
    assert.equal((await stream.read()).event.kind, 'snapshot');
    const compacted = await rig.api(rig.conversation(session.id) + '/compact', { instructions: 'Keep it short' });
    assert.equal(compacted.status, 202);

    let reset;

    while (!reset) reset = (await stream.read()).event.kind === 'snapshot';
    await converge(stream, () => rig.snapshot(session.id));
    await stream.close();
  } finally {
    await rig.close();
  }
});

test(
  'a committed tool entry whose remote outcome resolves is sent again with its ID',
  { timeout: 120_000 },
  async () => {
    const rig = await lifecycleRig();
    let stopWrites = false;
    let identity: ReturnType<typeof commandIdentity> | undefined;

    // The stop marker can't be written, so the cancelled command stays open and its committed result is uncertain.
    rig.setIntercept(({ path, body }) => {
      if (path.endsWith('/commands')) identity = commandIdentity(body);

      return stopWrites && path.endsWith('/file') && body.includes('.cancel')
        ? new Response('sandbox unreachable', { status: 503 })
        : undefined;
    });

    try {
      const session = await rig.create();
      const call = rig.bash('printf started; sleep 30; printf must-not-survive');
      const active = await rig.accepted(await rig.send(session.id, 'Run and cancel', undefined, call));
      await waitFor(async () => identity);
      await setTimeout(500);
      stopWrites = true;

      const cancelled = await rig.api(rig.conversation(session.id) + '/cancel', {
        operationId: crypto.randomUUID(),
        runId: active.runId,
      });

      assert.equal(cancelled.status, 503);
      stopWrites = false;

      const tool = (snapshot: Snapshot) =>
        snapshot.history.entries.find((entry) => entry.kind === 'tool' && entry.toolCallId === call.id);

      const outcome = (snapshot: Snapshot) => {
        const entry = tool(snapshot);

        return entry?.kind === 'tool' ? entry.outcome.kind : undefined;
      };

      const stream = await connect(rig, session.id, {});
      const uncertain = await stream.until((snapshot) => outcome(snapshot) === 'uncertain');
      const id = tool(uncertain)?.id;
      await stream.until((snapshot) => outcome(snapshot) !== undefined && outcome(snapshot) !== 'uncertain');
      await stream.close();

      const resent = stream.received.filter(
        ({ event }) => event.kind === 'entries' && event.entries.some((entry) => entry.id === id),
      );

      assert.ok(resent.length >= 1, 'the changed entry came again as an entries event');
      assert.ok(
        stream.received.every(({ event }, index) => index === 0 || event.kind !== 'snapshot'),
        'no reset',
      );
    } finally {
      await rig.close();
    }
  },
);

test(
  'a streaming burst calls no other object; the heartbeat is a session event that reads the sandbox state',
  { timeout: 120_000 },
  async () => {
    const rig = await lifecycleRig();
    const marks = Array.from({ length: 40 }, (_, index) => `<${index}>`);
    rig.setAnswer(() => streamedAnswer(model.id, marks, 50));

    try {
      const session = await rig.create();
      const stream = await connect(rig, session.id, {});
      await stream.read();
      await rig.accepted(await rig.send(session.id, 'Stream an answer'));

      const showing = (mark: string) => (snapshot: Snapshot) =>
        JSON.stringify(snapshot.live.message ?? '').includes(mark);

      await stream.until(showing('<2>'));
      const before = await calls(rig, session.id);
      const from = stream.received.length;
      await stream.until(showing('<30>'));
      const after = await calls(rig, session.id);

      const frames = stream.received.slice(from).filter(({ event }) => event.kind === 'live').length;
      assert.ok(frames >= 5, `${frames} live events in the burst`);
      assert.equal(after['catalog.workspaceState'] ?? 0, before['catalog.workspaceState'] ?? 0);
      assert.equal(callsTo(after, 'credentials.'), callsTo(before, 'credentials.'), JSON.stringify({ before, after }));

      await converge(stream, () => rig.snapshot(session.id));
      const quiet = (await calls(rig, session.id))['catalog.workspaceState'] ?? 0;

      // Within 15 seconds of the first frame a heartbeat reads the sandbox state, then sends the session.
      for (;;) {
        const { event, id } = await stream.read();

        if (event.kind !== 'session') continue;
        assert.equal(id, undefined);

        if (((await calls(rig, session.id))['catalog.workspaceState'] ?? 0) > quiet) break;
      }

      await stream.close();
    } finally {
      await rig.close();
    }
  },
);
