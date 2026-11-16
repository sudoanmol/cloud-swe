/**
 * Path: server/test/anthropic-live.test.ts
 * Used by: pnpm test.
 * Purpose: Sends the real model through the Worker with the Docker sandbox: a turn that must run a tool, its event stream and usage, and a wrong key's sanitized failure; runs only with pnpm test --anthropic, and is billed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { Session, Snapshot } from '@cloud-swe/protocol';
import { Request as WorkerRequest, Response as WorkerResponse } from 'miniflare';
import { z } from 'zod';

import { failureMessage } from '../src/sessions/failures.ts';
import { sameState, sessionEvents } from './event-stream.ts';
import { type Answer, lifecycleRig } from './lifecycle-rig.ts';
import { headers, runEnded, sandboxRun, storedText, waitFor } from './rig.ts';
import { forwardOutbound } from './runtime.ts';

// Billed at cents a run: runs only with MODEL_BACKEND=anthropic, which pnpm test --anthropic sets.
const live = process.env.MODEL_BACKEND === 'anthropic';
const key = process.env.ANTHROPIC_API_KEY ?? '';

/** Sends a model request, whose body the rig has already read, on to the real Anthropic API. */
const toAnthropic: Answer = (body, request) =>
  forwardOutbound(new WorkerRequest(request.url, { method: request.method, headers: request.headers, body }));

const assistantText = (entries: Snapshot['history']['entries']) =>
  entries
    .flatMap((entry) => (entry.kind === 'message' && entry.role === 'assistant' ? entry.content : []))
    .flatMap((block) => (block.kind === 'text' ? [block.text] : []))
    .join('\n');

const promptTokens = ({ usage }: Session) => usage.input + usage.cacheRead + usage.cacheWrite;

test(
  'the real model runs a shell command, streams its answer and is billed',
  { skip: !live, timeout: 300_000 },
  async (t) => {
    const rig = await lifecycleRig({ ANTHROPIC_API_KEY: key });
    rig.setAnswer(toAnthropic);

    try {
      const session = await rig.create();
      await waitFor(
        () => rig.boxState(session.workspace.id),
        (state) => state === 'running',
      );
      // Only a command in the sandbox can find this out.
      const token = crypto.randomUUID();
      assert.equal((await sandboxRun(session.workspace.id, `printf %s ${token} > live-check.txt`)).code, 0);
      const before = await rig.session(session.id);

      const stream = await sessionEvents(
        new URL(rig.conversation(session.id) + '/events', rig.base()),
        headers,
        undefined,
        240_000,
      );

      assert.equal((await stream.read()).event.kind, 'snapshot');

      await rig.accepted(
        await rig.send(
          session.id,
          'Use your bash tool to run `cat live-check.txt` in your working directory. Then reply with the exact output and one short sentence saying what you ran.',
        ),
      );

      await stream.until((state) => runEnded(state.session));
      const done = await rig.session(session.id);

      // The events after the run ended can trail the server's state by a frame.
      let snapshot = await rig.snapshot(session.id);

      while (!sameState(stream.held().snapshot, snapshot)) {
        await stream.next();
        snapshot = await rig.snapshot(session.id);
      }

      await stream.close();

      await t.test('the run calls a tool in the sandbox and finishes with what it read', () => {
        assert.equal(done.run.kind, 'completed', JSON.stringify(done.run));

        const read = snapshot.history.entries.find(
          (entry) =>
            entry.kind === 'tool' && entry.outcome.kind === 'succeeded' && entry.outcome.output?.includes(token),
        );

        assert.ok(read, 'a tool succeeded with the file contents');
        assert.match(
          assistantText(snapshot.history.entries.slice(snapshot.history.entries.indexOf(read))),
          new RegExp(token),
        );
      });

      await t.test('the stream showed the partial message, rebuilds the snapshot, and usage grew', async () => {
        const events = stream.received.map(({ event }) => event);
        const partial = events.findIndex((event) => event.kind === 'live' && event.live.message !== null);

        const committed = events.findLastIndex(
          (event) =>
            event.kind === 'entries' &&
            event.entries.some((entry) => entry.kind === 'message' && entry.role === 'assistant'),
        );

        assert.ok(partial >= 0, 'a live event carried a partial assistant message');
        assert.ok(partial < committed, 'before an assistant entry committed');
        assert.ok(sameState(stream.held().snapshot, snapshot), 'the events rebuild the server snapshot');

        // Pi marks the newest message for the prompt cache, so most prompt tokens may count as cache writes or reads.
        assert.ok(promptTokens(done) > promptTokens(before), 'prompt tokens grew');
        assert.ok(done.usage.output > before.usage.output, 'output tokens grew');
        assert.ok(done.usage.cost.total > before.usage.cost.total, 'the cost grew');

        const stored = await storedText(rig.storage);
        assert.equal(stored.includes(key), false, 'no Thread stores the key');
      });
    } finally {
      await rig.close();
    }
  },
);

const ProviderError = z.object({ error: z.object({ type: z.string().min(1), message: z.string().min(1) }) });

test(
  'a wrong key fails the run as auth, with none of the provider text',
  { skip: !live, timeout: 180_000 },
  async () => {
    const rig = await lifecycleRig();
    const wrong = `sk-ant-api03-wrong-${crypto.randomUUID()}`;
    const answers: { status: number; text: string }[] = [];

    rig.setAnswer(async (body, request) => {
      assert.equal(request.headers.get('x-api-key'), wrong, "the account's saved key is the one sent");
      const response = await toAnthropic(body, request);
      const text = await response.text();
      answers.push({ status: response.status, text });

      return new WorkerResponse(text, { status: response.status, headers: response.headers });
    });

    try {
      const saved = await rig.api('/v1/credentials/models/anthropic', { key: wrong }, 'PUT');
      assert.equal(saved.status, 200);
      assert.equal(z.object({ source: z.string() }).parse(await saved.json()).source, 'client');

      const session = await rig.create();
      await rig.accepted(await rig.send(session.id, 'Say hi'));
      const failed = await waitFor(() => rig.session(session.id), runEnded, 120_000);

      assert.deepEqual(failed.run.kind === 'failed' && [failed.run.code, failed.run.message], [
        'auth',
        failureMessage('auth'),
      ]);
      assert.deepEqual(
        answers.map(({ status }) => status),
        [401],
        'one request, not retried',
      );

      const provider = ProviderError.parse(JSON.parse(answers[0]?.text ?? ''));

      const responses = [
        JSON.stringify(failed),
        await (await rig.api(rig.conversation(session.id) + '/snapshot')).text(),
        await (await rig.api(rig.conversation(session.id) + '/history?limit=100')).text(),
        await storedText(rig.storage),
      ];

      for (const text of responses) {
        assert.equal(text.includes(provider.error.message), false, "the provider's message is nowhere");
        assert.equal(text.includes(provider.error.type), false, "the provider's error type is nowhere");
        assert.equal(text.includes(wrong), false, 'the key is nowhere');
      }
    } finally {
      await rig.close();
    }
  },
);
