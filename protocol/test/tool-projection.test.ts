import assert from 'node:assert/strict';
import test from 'node:test';

import { Entry, ToolActivity, ToolOutcome } from '../src/index.ts';
import { NativeContent, NativeLive } from '../src/native.ts';

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

  const activity = ToolActivity.parse({
    toolCallId: 'call-A/c1',
    parentToolCallId: 'call-A',
    taskId: '42',
    name: 'bash',
    arguments: { command: 'pwd' },
    outcome: { kind: 'running', output: '/work' },
  });

  assert.equal(activity.parentToolCallId, 'call-A');
  assert.equal(activity.taskId, '42');
  assert.deepEqual(activity.nestedCalls, []);
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

test('native live slots preserve pending status and nested arguments while unknown fields stay native', () => {
  const live = NativeLive.parse({
    tools: [{ callId: 'parent', name: 'codemode', taskId: 3, status: 'running' }],
    nestedTools: [
      {
        callId: 'parent/c1',
        name: 'read',
        taskId: 4,
        parentTaskId: 3,
        parentCallId: 'parent',
        arguments: { path: 'a.ts' },
        status: 'done',
        summary: { isError: false },
      },
    ],
  });

  assert.equal(live.nestedTools?.[0]?.arguments.path, 'a.ts');
  assert.equal(live.nestedTools?.[0]?.parentCallId, 'parent');
});
