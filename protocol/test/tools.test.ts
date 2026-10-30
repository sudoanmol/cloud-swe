import assert from 'node:assert/strict';
import test from 'node:test';

import { CommandRecord } from '../src/index.ts';
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
