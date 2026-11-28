/**
 * Path: server/test/two-clients.test.ts
 * Used by: pnpm test.
 * Purpose: Two clients on one session see each other's messages, queued input, tool activity and renames, sooner than the heartbeat, and both rebuild the server's snapshot.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { Snapshot } from '@cloud-swe/protocol';

import { sameState, sessionEvents } from './event-stream.ts';
import { createSession, gitWorker, settled } from './git-env.ts';
import { FakeGitHub } from './github-fake.ts';
import { headers, sandboxFile, waitFor } from './rig.ts';

// The heartbeat re-sends state every 15 seconds, so seeing a change sooner proves it was pushed.
const BEFORE_HEARTBEAT_MS = 5_000;

async function client(url: URL) {
  const stream = await sessionEvents(url, headers);
  let last = await stream.next();
  let closed = false;
  const waiters = new Set<() => void>();

  const pump = (async () => {
    while (!closed) {
      last = await stream.next();

      for (const waiter of waiters) waiter();
    }
  })().catch(() => {});

  const sees = async (what: string, matches: (snapshot: Snapshot) => boolean, limit = BEFORE_HEARTBEAT_MS) => {
    const started = Date.now();

    while (!matches(last)) {
      const remaining = limit - (Date.now() - started);
      assert.ok(remaining > 0, `${what}: not seen within ${limit} ms`);

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);

        const waiter = () => {
          clearTimeout(timer);
          waiters.delete(waiter);
          resolve();
        };

        waiters.add(waiter);
      });
    }
  };

  const close = async () => {
    closed = true;
    await stream.close();
    await pump;
  };

  return { sees, close };
}

test('two clients stay in sync on messages, queued input, tools and renames', { timeout: 180_000 }, async () => {
  const fake = await FakeGitHub.create();
  await fake.repo('octo', 'hello');
  const calls: NonNullable<Parameters<typeof gitWorker>[2]> = [];
  const worker = await gitWorker(fake, 8805, calls);
  const { api } = worker;

  try {
    const session = await createSession(api, 'https://github.com/octo/hello');
    const path = `/v1/sessions/${session.id}`;
    await waitFor(() => sandboxFile(session.workspace.id, 'hello/README'));
    const url = new URL(path + '/conversations/1/events', worker.base);
    const clients = [await client(url), await client(url)];

    const both = (what: string, matches: (snapshot: Snapshot) => boolean, limit?: number) =>
      Promise.all(clients.map((each) => each.sees(what, matches, limit)));

    const post = async (text: string, mode: 'reject' | 'followUp') => {
      const response = await api(`${path}/conversations/1/messages`, 'POST', {
        operationId: crypto.randomUUID(),
        text,
        mode,
      });

      assert.equal(response.status, 202, await response.clone().text());
    };

    const inTranscript = (text: string) => (snapshot: Snapshot) =>
      JSON.stringify(snapshot.history.entries).includes(text);

    // A long tool call keeps the run busy while a second message waits.
    calls.push([{ id: 'slow', name: 'bash', arguments: { command: 'sleep 8' } }]);
    await post('first prompt', 'reject');
    await both('the prompt', inTranscript('first prompt'));
    await both('the tool call', (snapshot) => snapshot.live.tools.some((tool) => tool.toolCallId === 'slow'));

    await post('queued prompt', 'followUp');
    await both('the queued text', (snapshot) =>
      snapshot.session.pending.some((input) => input.mode === 'followUp' && input.text === 'queued prompt'),
    );

    await both('the queued message running', inTranscript('queued prompt'), 30_000);
    await settled(api, session.id);

    // A rename changes state outside Pi, so only the Thread can announce it.
    assert.equal((await api(path, 'PATCH', { title: 'Renamed' })).status, 200);
    await both('the rename', (snapshot) => snapshot.session.title === 'Renamed');

    // What each client built from the events is exactly the server's snapshot.
    const expected = Snapshot.parse(await (await api(`${path}/conversations/1/snapshot`)).json());
    await both('the server snapshot', (snapshot) => sameState(snapshot, expected));

    await Promise.all(clients.map((each) => each.close()));
  } finally {
    await worker.close();
  }
});
