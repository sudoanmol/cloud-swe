/**
 * Path: server/test/transcript.test.ts
 * Used by: pnpm test.
 * Purpose: History pagination, stable IDs and snapshot SSE survive reconnect and restart.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CreateSessionResponse, HistoryResponse, SessionEvent, Snapshot } from '@cloud-swe/protocol';
import { Response as WorkerResponse } from 'miniflare';

import { modelAnswer } from './model-answer.ts';
import { runtime } from './runtime.ts';

test(
  'native history pagination, stable IDs and snapshot SSE reset survive reconnect and restart',
  { timeout: 30_000 },
  async () => {
    const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-transcript-'));
    const model = { provider: 'anthropic', id: 'claude-sonnet-5-5' };
    const bindings = { WORKSPACE_BACKEND: 'docker', MODEL_ID: model.id, ANTHROPIC_API_KEY: 'fake-key' };
    let finish: (() => void) | undefined;
    const started = Promise.withResolvers<void>();

    const dev = {
      outboundService: {
        type: 'fetcher',
        handler: async (request) => {
          if (new URL(request.url).hostname === 'api.anthropic.com') {
            await new Promise<void>((resolve) => {
              finish = resolve;
              started.resolve();
            });

            return modelAnswer(model.id);
          }

          assert.equal(new URL(request.url).hostname, 'sandbox');

          const response = await fetch(request.url, {
            method: request.method,
            headers: [...request.headers],
            body: request.method === 'GET' ? undefined : await request.text(),
          });

          return new WorkerResponse(await response.arrayBuffer(), { status: response.status });
        },
      },
    } satisfies NonNullable<Parameters<typeof runtime>[2]>;

    let mf = runtime(storage, bindings, dev);
    let base = await mf.ready;
    const headers = { Authorization: 'Bearer integration-test-personal-token', 'Content-Type': 'application/json' };

    const create = async () => {
      const response = await fetch(new URL('/v1/sessions', base), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          environment: 'base',
          model,
        }),
      });

      assert.equal(response.status, 201, await response.clone().text());

      return CreateSessionResponse.parse(await response.json()).session;
    };

    const streams: ReadableStreamDefaultReader<Uint8Array>[] = [];

    try {
      const session = await create();
      const path = '/v1/sessions/' + session.id;

      const get = (suffix: string) =>
        fetch(new URL(path + suffix, base), { headers, signal: AbortSignal.timeout(10_000) });

      const connect = async () => {
        const response = await get('/events');
        assert.match(response.headers.get('Content-Type') ?? '', /text\/event-stream/);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        assert.ok(response.body);
        const reader = response.body.getReader();
        streams.push(reader);
        let buffered = '';
        const decoder = new TextDecoder();

        return {
          reader,
          next: async () => {
            for (;;) {
              const boundary = buffered.indexOf('\n\n');

              if (boundary >= 0) {
                const frame = buffered.slice(0, boundary);
                buffered = buffered.slice(boundary + 2);
                const data = frame.split('\n').find((line) => line.startsWith('data: '));

                if (!data) continue;
                const event = SessionEvent.parse(JSON.parse(data.slice(6)));
                assert.equal(event.kind, 'snapshot');

                if (event.kind === 'snapshot') return event.snapshot;
              }

              const chunk = await reader.read();
              assert.equal(chunk.done, false, 'SSE ended unexpectedly');
              buffered += decoder.decode(chunk.value, { stream: true });
            }
          },
        };
      };

      const stream = await connect();
      const initial = await stream.next();
      assert.equal(initial.session.id, session.id);
      assert.deepEqual(initial, Snapshot.parse(await (await get('/snapshot')).json()));

      const submitted = await fetch(new URL(path + '/messages', base), {
        method: 'POST',
        headers,
        body: JSON.stringify({ operationId: crypto.randomUUID(), text: 'history input' }),
      });

      assert.equal(submitted.status, 202);
      let frame = await stream.next();

      while (frame.session.run.kind !== 'running') frame = await stream.next();
      await stream.reader.cancel();
      const reconnect = await connect();
      assert.equal(
        (await reconnect.next()).session.run.kind,
        'running',
        'disconnect does not cancel the accepted input',
      );
      await started.promise;
      assert.ok(finish);
      finish();
      frame = await reconnect.next();

      while (frame.session.run.kind !== 'completed') frame = await reconnect.next();
      assert.ok(frame.history.entries.some((entry) => entry.kind === 'message' && entry.role === 'assistant'));
      await reconnect.reader.cancel();
      const full = HistoryResponse.parse(await (await get('/history?limit=100')).json());
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
      const other = await create();
      const firstPage = HistoryResponse.parse(await (await get('/history?limit=1')).json());
      assert.ok(firstPage.nextCursor);
      assert.equal(
        (
          await fetch(
            new URL('/v1/sessions/' + other.id + '/history?cursor=' + encodeURIComponent(firstPage.nextCursor), base),
            { headers },
          )
        ).status,
        400,
      );
      await mf.dispose();
      mf = runtime(storage, bindings, dev);
      base = await mf.ready;
      assert.deepEqual(HistoryResponse.parse(await (await get('/history?limit=100')).json()), full);
      const restarted = await connect();
      assert.equal((await restarted.next()).session.run.kind, 'completed');
      await restarted.reader.cancel();
    } finally {
      finish?.();

      for (const reader of streams) await reader.cancel().catch(() => {});
      await mf.dispose();
      await rm(storage, { recursive: true, force: true });
    }
  },
);
