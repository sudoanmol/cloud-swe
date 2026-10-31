/**
 * Path: server/test/tool-events.test.ts
 * Used by: pnpm test.
 * Purpose: Snapshot and SSE expose tool arguments, live output, results and cancellation.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CreateSessionResponse, HistoryResponse, OperationReceipt, Snapshot } from '@cloud-swe/protocol';
import type { ToolCall } from '@earendil-works/pi-ai';
import { Response as WorkerResponse } from 'miniflare';

import { sessionEvents } from './event-stream.ts';
import { modelAnswer } from './model-answer.ts';
import { runtime } from './runtime.ts';

const headers = { Authorization: 'Bearer integration-test-personal-token', 'Content-Type': 'application/json' };

test(
  'snapshot/SSE exposes native parent and nested tool arguments, live output, results, cancellation and restart history',
  { timeout: 50_000 },
  async () => {
    const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-tool-events-'));
    const model = { provider: 'anthropic', id: 'claude-sonnet-5-5' };
    const bindings = { WORKSPACE_BACKEND: 'docker', MODEL_ID: model.id, ANTHROPIC_API_KEY: 'fake-key' };
    let next: Pick<ToolCall, 'id' | 'name' | 'arguments'> | undefined;

    const dev = {
      outboundService: {
        type: 'fetcher',
        handler: async (request) => {
          if (new URL(request.url).hostname === 'api.anthropic.com') {
            const call = next;
            next = undefined;

            return modelAnswer(model.id, call ? [call] : []);
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
    const streams: Array<Awaited<ReturnType<typeof sessionEvents>>> = [];
    let path = '';

    const connect = async () => {
      const stream = await sessionEvents(new URL(path + '/events', base), headers);
      streams.push(stream);

      return stream;
    };

    const send = async (call: NonNullable<typeof next>) => {
      next = call;

      const response = await fetch(new URL(path + '/messages', base), {
        method: 'POST',
        headers,
        body: JSON.stringify({ operationId: crypto.randomUUID(), text: 'Exercise tool events' }),
      });

      assert.equal(response.status, 202, await response.clone().text());

      return OperationReceipt.parse(await response.json());
    };

    try {
      const created = await fetch(new URL('/v1/sessions', base), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          engine: 'pi',
          target: 'cloud',
          environment: 'base',
          model,
        }),
      });

      assert.equal(created.status, 201);
      const session = CreateSessionResponse.parse(await created.json()).session;
      path = '/v1/sessions/' + session.id;
      const initial = await connect();
      assert.deepEqual((await initial.next()).tools, []);
      await send({
        id: 'parent-code',
        name: 'codemode',
        arguments: {
          code: `await tools.write({path: 'event.txt', content: 'event-content'});
await tools.read({path: 'event.txt'});
const results = await Promise.all([
  tools.bash({command: 'printf left-start; sleep 4; printf left-end'}),
  tools.bash({command: 'printf right-start; sleep 4; printf right-end'})
]); return results;`,
        },
      });
      let running = await initial.next();

      for (let attempt = 0; attempt < 200; attempt++) {
        const child = running.tools.find(
          (tool) =>
            tool.parentToolCallId === 'parent-code' &&
            tool.name === 'bash' &&
            tool.outcome.kind === 'running' &&
            tool.outcome.output?.includes('left-start'),
        );

        if (child) break;
        running = await initial.next();
      }

      const parent = running.tools.find((tool) => tool.toolCallId === 'parent-code');
      assert.equal(parent?.name, 'codemode');
      assert.equal(parent?.outcome.kind, 'running');
      assert.match(String(parent?.arguments?.code), /Promise.all/);
      const children = running.tools.filter((tool) => tool.parentToolCallId === 'parent-code');
      assert.equal(children.filter((tool) => tool.name === 'bash').length, 2);
      assert.ok(
        children.every((tool) => tool.toolCallId.startsWith('parent-code/') && /^[0-9]+$/.test(tool.taskId ?? '')),
      );
      const read = children.find((tool) => tool.name === 'read');
      assert.equal(read?.arguments?.path, 'event.txt');
      assert.equal(read?.outcome.kind, 'succeeded');

      if (read?.outcome.kind === 'succeeded') assert.equal(read.outcome.output, 'event-content');
      await initial.close();
      const reconnect = await connect();
      const replacement = await reconnect.next();
      assert.equal(replacement.session.run.kind, 'running');
      assert.ok(replacement.tools.some((tool) => tool.parentToolCallId === 'parent-code' && tool.name === 'bash'));
      let finished = replacement;

      for (let attempt = 0; attempt < 200; attempt++) {
        if (
          finished.session.run.kind === 'completed' &&
          finished.history.entries.some((entry) => entry.kind === 'tool' && entry.name === 'codemode')
        )
          break;
        finished = await reconnect.next();
      }

      const result = finished.history.entries.find((entry) => entry.kind === 'tool' && entry.name === 'codemode');
      assert.equal(result?.kind, 'tool');

      if (result?.kind === 'tool') {
        assert.equal(result.outcome.kind, 'succeeded');
        assert.match(result.outcome.kind === 'succeeded' ? (result.outcome.output ?? '') : '', /left-end/);
        assert.equal(result.nestedCalls.length, 4);
        assert.ok(result.nestedCalls.every((call) => call.status === 'succeeded'));
        assert.match(result.id, /^[0-9]+$/);
      }

      assert.ok(
        finished.history.entries.some(
          (entry) =>
            entry.kind === 'message' &&
            entry.content.some((block) => block.kind === 'tool_call' && block.toolCallId === 'parent-code'),
        ),
      );
      await reconnect.close();

      const cancelStream = await connect();
      await cancelStream.next();

      const active = await send({
        id: 'cancel-tool',
        name: 'bash',
        arguments: { command: 'printf cancel-start; sleep 10; printf must-not-run' },
      });

      let cancellable = await cancelStream.next();

      for (let attempt = 0; attempt < 200; attempt++) {
        if (
          cancellable.tools.some(
            (tool) =>
              tool.toolCallId === 'cancel-tool' &&
              tool.outcome.kind === 'running' &&
              tool.outcome.output?.includes('cancel-start'),
          )
        )
          break;
        cancellable = await cancelStream.next();
      }

      const cancelled = await fetch(new URL(path + '/cancel', base), {
        method: 'POST',
        headers,
        body: JSON.stringify({ operationId: crypto.randomUUID(), runId: active.runId }),
      });

      assert.equal(cancelled.status, 202, await cancelled.clone().text());
      let stopped = await cancelStream.next();

      for (let attempt = 0; attempt < 200; attempt++) {
        if (
          stopped.session.run.kind === 'cancelled' &&
          stopped.history.entries.some(
            (entry) =>
              entry.kind === 'tool' && entry.toolCallId === 'cancel-tool' && entry.outcome.kind === 'interrupted',
          )
        )
          break;
        stopped = await cancelStream.next();
      }

      assert.equal(stopped.session.run.kind, 'cancelled');
      assert.ok(
        stopped.history.entries.some(
          (entry) =>
            entry.kind === 'tool' && entry.toolCallId === 'cancel-tool' && entry.outcome.kind === 'interrupted',
        ),
      );
      await cancelStream.close();

      const before = HistoryResponse.parse(
        await (await fetch(new URL(path + '/history?limit=100', base), { headers })).json(),
      );

      assert.ok(before.entries.some((entry) => entry.kind === 'tool' && entry.name === 'codemode'));
      await mf.dispose();
      mf = runtime(storage, bindings, dev);
      base = await mf.ready;

      const after = HistoryResponse.parse(
        await (await fetch(new URL(path + '/history?limit=100', base), { headers })).json(),
      );

      assert.deepEqual(after, before);
      const snapshot = Snapshot.parse(await (await fetch(new URL(path + '/snapshot', base), { headers })).json());
      assert.equal(snapshot.session.run.kind, 'cancelled');
      assert.equal(snapshot.toolsTruncated, false);
    } finally {
      for (const stream of streams) await stream.close().catch(() => {});
      await mf.dispose();
      await rm(storage, { recursive: true, force: true });
    }
  },
);
