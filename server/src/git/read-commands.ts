/**
 * Path: server/src/git/read-commands.ts
 * Used by: server/src/git/proxy.ts.
 * Purpose: Reads a receive-pack request body only as far as its command list, then replays everything read plus the untouched rest.
 */
import { concat, parsePushRequest, type PushRequest } from './pktline.ts';

// The command list is tiny; refuse a list that is still incomplete past this, so a pack is never buffered.
export const MAX_COMMANDS_BYTES = 64 * 1024;

/** Reads from `body` until the command list is complete; returns it with a stream of every byte, read or not. */
export async function readCommands(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  let buffered = new Uint8Array(0);
  let request: PushRequest | undefined;

  while (!request) {
    const chunk = await reader.read();

    if (chunk.done) throw new Error('Truncated push request');
    buffered = concat([buffered, chunk.value]);
    // Parse first: a first chunk that also carries the start of the pack is large but valid.
    request = parsePushRequest(buffered);

    if (!request && buffered.length > MAX_COMMANDS_BYTES) throw new Error('Push command list too large');
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(buffered);
    },
    async pull(controller) {
      const next = await reader.read();

      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });

  return { request, stream };
}
