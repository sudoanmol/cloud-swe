/**
 * Path: server/test/tool-events.test.ts
 * Used by: pnpm test.
 * Purpose: Snapshot and SSE expose tool arguments, live output, results and cancellation.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { sessionEvents } from './event-stream.ts';
import { lifecycleRig } from './lifecycle-rig.ts';
import type { Call } from './rig.ts';

test(
  'snapshot/SSE exposes native parent and nested tool arguments, live output, results, cancellation and restart history',
  { timeout: 50_000 },
  async () => {
    const rig = await lifecycleRig();
    const streams: Array<Awaited<ReturnType<typeof sessionEvents>>> = [];

    try {
      const session = await rig.create();
      const path = '/v1/sessions/' + session.id;

      const connect = async () => {
        const stream = await rig.events(session.id);
        streams.push(stream);

        return stream;
      };

      const send = async (call: Call) =>
        rig.accepted(await rig.send(session.id, 'Exercise tool events', undefined, call));

      const initial = await connect();
      assert.deepEqual((await initial.next()).live.tools, []);
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

      const running = await initial.until((frame) =>
        frame.live.tools.some(
          (tool) =>
            tool.parentToolCallId === 'parent-code' &&
            tool.name === 'bash' &&
            tool.outcome.kind === 'running' &&
            tool.outcome.output?.includes('left-start'),
        ),
      );

      const parent = running.live.tools.find((tool) => tool.toolCallId === 'parent-code');
      assert.equal(parent?.name, 'codemode');
      assert.equal(parent?.outcome.kind, 'running');
      assert.match(String(parent?.arguments?.code), /Promise.all/);
      const children = running.live.tools.filter((tool) => tool.parentToolCallId === 'parent-code');
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
      assert.ok(replacement.live.tools.some((tool) => tool.parentToolCallId === 'parent-code' && tool.name === 'bash'));

      const finished = await reconnect.until(
        (frame) =>
          frame.session.run.kind === 'completed' &&
          frame.history.entries.some((entry) => entry.kind === 'tool' && entry.name === 'codemode'),
      );

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

      await cancelStream.until((frame) =>
        frame.live.tools.some(
          (tool) =>
            tool.toolCallId === 'cancel-tool' &&
            tool.outcome.kind === 'running' &&
            tool.outcome.output?.includes('cancel-start'),
        ),
      );

      const cancelled = await rig.api(path + '/cancel', { operationId: crypto.randomUUID(), runId: active.runId });

      assert.equal(cancelled.status, 202, await cancelled.clone().text());
      await cancelStream.until(
        (frame) =>
          frame.session.run.kind === 'cancelled' &&
          frame.history.entries.some(
            (entry) =>
              entry.kind === 'tool' && entry.toolCallId === 'cancel-tool' && entry.outcome.kind === 'interrupted',
          ),
      );
      await cancelStream.close();

      const before = await rig.history(session.id);

      assert.ok(before.entries.some((entry) => entry.kind === 'tool' && entry.name === 'codemode'));
      await rig.restart();
      assert.deepEqual(await rig.history(session.id), before);
      const snapshot = await rig.snapshot(session.id);
      assert.equal(snapshot.session.run.kind, 'cancelled');
      assert.equal(snapshot.live.toolsTruncated, false);
    } finally {
      for (const stream of streams) await stream.close().catch(() => {});
      await rig.close();
    }
  },
);
