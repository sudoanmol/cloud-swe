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

import { CreateSessionResponse, HistoryResponse, Snapshot } from '@cloud-swe/protocol';
import { Response as WorkerResponse } from 'miniflare';

import { sessionEvents } from './event-stream.ts';
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
          template: 'base',
          model,
        }),
      });

      assert.equal(response.status, 201, await response.clone().text());

      return CreateSessionResponse.parse(await response.json()).session;
    };

    const streams: Awaited<ReturnType<typeof sessionEvents>>[] = [];

    try {
      const session = await create();
      const path = '/v1/sessions/' + session.id;

      const get = (suffix: string) =>
        fetch(new URL(path + suffix, base), { headers, signal: AbortSignal.timeout(10_000) });

      const connect = async () => {
        const stream = await sessionEvents(new URL(path + '/events', base), headers);
        streams.push(stream);

        return stream;
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
      await stream.until((frame) => frame.session.run.kind === 'running');
      await stream.close();
      const reconnect = await connect();
      assert.equal(
        (await reconnect.next()).session.run.kind,
        'running',
        'disconnect does not cancel the accepted input',
      );
      await started.promise;
      assert.ok(finish);
      finish();
      const frame = await reconnect.until((snapshot) => snapshot.session.run.kind === 'completed');
      assert.ok(frame.history.entries.some((entry) => entry.kind === 'message' && entry.role === 'assistant'));
      await reconnect.close();
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
      await restarted.close();
    } finally {
      finish?.();

      for (const stream of streams) await stream.close().catch(() => {});
      await mf.dispose();
      await rm(storage, { recursive: true, force: true });
    }
  },
);
