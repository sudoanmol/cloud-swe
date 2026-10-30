import assert from 'node:assert/strict';
import test from 'node:test';

import { Entry, ToolOutcome } from '../src/index.ts';
import { NativeContent } from '../src/native.ts';

test('tool arguments and parent identity are native values, including calls inside assistant content', () => {
  const content = NativeContent.parse([
    { type: 'text', text: 'Working' },
    { type: 'toolCall', id: 'call-A', name: 'codemode', arguments: { code: 'return 1' } },
  ]);

  assert.deepEqual(content[1], {
    kind: 'tool_call',
    toolCallId: 'call-A',
    name: 'codemode',
    arguments: { code: 'return 1' },
  });
});

test('history can report unavailable arguments/results without inventing empty objects or success', () => {
  const entry = Entry.parse({
    id: '21',
    runId: null,
    createdAt: '2026-10-29T12:00:00Z',
    kind: 'tool',
    toolCallId: 'call-A',
    name: 'read',
    arguments: null,
    outcome: { kind: 'succeeded', output: 'contents' },
  });

  assert.equal(entry.kind, 'tool');
  assert.ok(ToolOutcome.safeParse({ kind: 'succeeded', output: null }).success);
  assert.equal(ToolOutcome.safeParse({ kind: 'uncertain', output: 'partial' }).success, false);
});
