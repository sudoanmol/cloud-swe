/**
 * Path: server/test/model-answer.ts
 * Used by: server/test/{attachments.test,compaction.test,controls.test,conversations.test,credentials.test,delta-stream.test,e2b-live.test,egress.test,environment-delivery.test,git-env,interaction.test,lifecycle-rig,lifecycle.test,long-response.test,messages.test,model-errors.test,network-proxy.test,rewind.test,secret-requests.test,session-list.test,stream-bytes.test,tools.test,transcript.test}.ts.
 * Purpose: Builds the Anthropic streaming and error responses tests answer model requests with.
 */

import { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { setTimeout } from 'node:timers/promises';

import { Response as WorkerResponse } from 'miniflare';

import type { Call } from './rig.ts';

const frame = (event: { type: string }) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

const messageStart = (model: string, inputTokens: number) => ({
  type: 'message_start',
  message: {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: 0 },
  },
});

export function modelAnswer(
  model: string,
  calls: readonly Call[] = [],
  { text = 'Test answer', inputTokens = 3 } = {},
) {
  const events = [
    messageStart(model, inputTokens),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    ...calls.flatMap((call, offset) => [
      {
        type: 'content_block_start',
        index: offset + 1,
        content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
      },
      {
        type: 'content_block_delta',
        index: offset + 1,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments) },
      },
      { type: 'content_block_stop', index: offset + 1 },
    ]),
    {
      type: 'message_delta',
      delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: 'message_stop' },
  ];

  return new WorkerResponse(events.map(frame).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
}

/** A plain text answer streamed in `chunks` over time, as a long generation arrives. Dropped connections just end it. */
export function streamedAnswer(model: string, chunks: readonly string[], delayMs: number) {
  const encoder = new TextEncoder();

  const body = new NodeReadableStream<Uint8Array>({
    async start(controller) {
      const send = <Event extends { type: string }>(event: Event) => controller.enqueue(encoder.encode(frame(event)));

      try {
        send(messageStart(model, 3));
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });

        for (const text of chunks) {
          send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
          await setTimeout(delayMs);
        }

        send({ type: 'content_block_stop', index: 0 });
        send({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 5 },
        });
        send({ type: 'message_stop' });
        controller.close();
      } catch {
        // The reader went away with its Worker.
      }
    },
  });

  return new WorkerResponse(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

/** An Anthropic error response. */
export const providerError = (status: number, type: string, message: string) =>
  WorkerResponse.json({ type: 'error', error: { type, message } }, { status });
