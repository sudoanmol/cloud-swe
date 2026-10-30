import type { ToolCall } from '@earendil-works/pi-ai';
import { Response as WorkerResponse } from 'miniflare';

export function modelAnswer(model: string, calls: readonly Pick<ToolCall, 'id' | 'name' | 'arguments'>[] = []) {
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
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Test answer' } },
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
