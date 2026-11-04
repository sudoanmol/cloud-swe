/**
 * Path: server/test/model-answer.ts
 * Used by: server/test/{codemode.test,command-recovery.test,compaction.test,controls.test,credentials.test,e2b-live.test,egress.test,environment-delivery.test,event-frames.test,git-env,history-arguments.test,interaction.test,lifecycle-rig,long-response.test,messages.test,model-errors.test,network-proxy.test,secret-requests.test,tool-events.test,tools.test,transcript.test}.ts.
 * Purpose: Builds the Anthropic streaming responses tests answer model requests with.
 */

import { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { setTimeout } from 'node:timers/promises';

import type { ToolCall } from '@earendil-works/pi-ai';
import { Response as WorkerResponse } from 'miniflare';

export function modelAnswer(
  model: string,
  calls: readonly Pick<ToolCall, 'id' | 'name' | 'arguments'>[] = [],
  { text = 'Test answer', inputTokens = 3 } = {},
) {
  const events = [
    {
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
    },
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

  return new WorkerResponse(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    {
      headers: { 'Content-Type': 'text/event-stream' },
    },
  );
}

/** A plain text answer streamed in `chunks` over time, as a long generation arrives. Dropped connections just end it. */
export function streamedAnswer(model: string, chunks: readonly string[], delayMs: number) {
  const frame = <Event extends { type: string }>(event: Event) =>
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

  const encoder = new TextEncoder();

  const body = new NodeReadableStream<Uint8Array>({
    async start(controller) {
      const send = <Event extends { type: string }>(event: Event) => controller.enqueue(encoder.encode(frame(event)));

      try {
        send({
          type: 'message_start',
          message: {
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 3, output_tokens: 0 },
          },
        });
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
