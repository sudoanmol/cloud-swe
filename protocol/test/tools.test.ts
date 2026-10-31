/**
 * Path: protocol/test/tools.test.ts
 * Used by: pnpm test.
 * Purpose: Contract tests for command transport, command records and tool projection.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CommandRecord, Entry, ToolOutcome } from '../src/index.ts';
import { NativeContent, NativeToolResult } from '../src/native.ts';
import { CommandOperation, FileContent, ShellInput, ShellProgress } from '../src/tools.ts';

const identity = {
  workspaceId: 'fa879d6e-bd71-48df-a621-f070c8df45da',
  operationId: 'fa879d6e-bd71-48df-a621-f070c8df45db',
};

test('shell transport has no default time limit; a timeout is optional and only sane values pass', () => {
  assert.ok(ShellInput.safeParse({ command: 'pwd', cwd: '/workspace' }).success);
  assert.ok(ShellInput.safeParse({ command: 'pwd', cwd: '/workspace', timeoutSeconds: 7200 }).success);

  for (const timeoutSeconds of [0, -1, 2_000_001]) {
    assert.equal(ShellInput.safeParse({ command: 'pwd', cwd: '/workspace', timeoutSeconds }).success, false);
  }

  assert.equal(FileContent.safeParse({ content: 'x'.repeat(400_001) }).success, false);
});

test('remote progress and persisted intent retain identity, bounded output and confirmed termination', () => {
  const running = { kind: 'running', identity, heartbeat: 1, output: 'partial', outputBytes: 7 };
  const { heartbeat: _, ...finished } = running;
  assert.ok(ShellProgress.safeParse(running).success);
  assert.ok(ShellProgress.safeParse({ ...finished, kind: 'exited', exitCode: 143, termination: 'cancelled' }).success);
  assert.equal(
    ShellProgress.safeParse({ ...finished, kind: 'exited', exitCode: null, termination: 'exit' }).success,
    false,
  );
  assert.equal(ShellProgress.safeParse({ ...running, output: 'x'.repeat(64_001) }).success, false);
  assert.ok(
    CommandOperation.safeParse({
      record: {
        kind: 'prepared',
        identity,
        cancelRequested: false,
        heartbeat: 0,
        lastSeenAt: 0,
        output: '',
        outputBytes: 0,
      },
      nativeTaskId: 1,
      toolCallId: 'tool-1',
      messageOperationId: identity.operationId,
      runId: identity.workspaceId,
      intent: '{"command":"pwd"}',
    }).success,
  );
});

test('terminal commands cannot carry a cancellation request or liveness', () => {
  const output = { output: '', outputBytes: 0 };

  for (const terminal of [
    { kind: 'exited', exitCode: 0, termination: 'exit', ...output },
    { kind: 'lost', reason: 'Supervisor stopped', ...output },
  ]) {
    assert.ok(CommandRecord.safeParse({ ...terminal, identity }).success);
    assert.equal(CommandRecord.safeParse({ ...terminal, identity, cancelRequested: true }).success, false);
    assert.equal(CommandRecord.safeParse({ ...terminal, identity, heartbeat: 1 }).success, false);
  }
});

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

test('a tool name over the protocol cap projects as unrecognized instead of throwing', () => {
  const name = 'x'.repeat(300);

  const content = NativeContent.safeParse([
    { type: 'text', text: 'hi' },
    { type: 'toolCall', id: 'call-A', name, arguments: {} },
  ]);

  assert.deepEqual(content.data, [{ kind: 'text', text: 'hi' }]);

  const result = NativeToolResult.safeParse({
    role: 'toolResult',
    toolCallId: 'call-A',
    toolName: name,
    content: 'nope',
    isError: true,
    timestamp: 1,
  });

  assert.equal(result.success, false);
});
