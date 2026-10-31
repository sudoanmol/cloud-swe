import assert from 'node:assert/strict';
import test from 'node:test';

import { concat, FLUSH, MAX_COMMANDS_BYTES, pkt, readCommands } from '../src/git/push.ts';

const command = `${'a'.repeat(40)} ${'b'.repeat(40)} refs/heads/work`;

const commandList = concat([pkt(new TextEncoder().encode(command + '\0report-status')), FLUSH]);

const streamOf = (...chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

async function drain(stream: ReadableStream<Uint8Array>) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

test('a valid push whose first chunk is far larger than the command limit is read and replayed whole', async () => {
  const pack = new Uint8Array(MAX_COMMANDS_BYTES * 3).fill(7);
  const body = concat([commandList, pack, pack]);
  const { request, stream } = await readCommands(streamOf(concat([commandList, pack]), pack));

  assert.deepEqual(request.commands, [{ old: 'a'.repeat(40), new: 'b'.repeat(40), ref: 'refs/heads/work' }]);
  assert.deepEqual(await drain(stream), body);
});

test('a command list that stays incomplete past the limit is refused', async () => {
  const line = pkt(new TextEncoder().encode(command));
  const unfinished = concat(Array.from({ length: Math.ceil(MAX_COMMANDS_BYTES / line.length) + 1 }, () => line));

  await assert.rejects(readCommands(streamOf(unfinished)), /too large/);
  await assert.rejects(readCommands(streamOf(new TextEncoder().encode('00'))), /Truncated/);
});
