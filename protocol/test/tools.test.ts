import assert from 'node:assert/strict';
import test from 'node:test';

import { CommandOperation, FileContent, ShellInput, ShellProgress } from '../src/tools.ts';

const identity = {
  workspaceId: 'fa879d6e-bd71-48df-a621-f070c8df45da',
  operationId: 'fa879d6e-bd71-48df-a621-f070c8df45db',
  runnerGeneration: 'fa879d6e-bd71-48df-a621-f070c8df45dc',
};

test('shell transport enforces bounded execution independently of native Pi parameters', () => {
  assert.ok(ShellInput.safeParse({ command: 'pwd', cwd: '/workspace', timeoutSeconds: 600 }).success);

  for (const timeoutSeconds of [0, -1, 601]) {
    assert.equal(ShellInput.safeParse({ command: 'pwd', cwd: '/workspace', timeoutSeconds }).success, false);
  }

  assert.equal(FileContent.safeParse({ content: 'x'.repeat(400_001) }).success, false);
});

test('remote progress and persisted intent retain identity, bounded output and confirmed termination', () => {
  const running = { kind: 'running', identity, output: 'partial', outputBytes: 7 };
  assert.ok(ShellProgress.safeParse(running).success);
  assert.ok(ShellProgress.safeParse({ ...running, kind: 'exited', exitCode: 143, termination: 'cancelled' }).success);
  assert.equal(
    ShellProgress.safeParse({ ...running, kind: 'exited', exitCode: null, termination: 'exit' }).success,
    false,
  );
  assert.equal(ShellProgress.safeParse({ ...running, output: 'x'.repeat(64_001) }).success, false);
  assert.ok(
    CommandOperation.safeParse({
      record: { kind: 'prepared', identity },
      nativeTaskId: 1,
      toolCallId: 'tool-1',
      messageOperationId: identity.operationId,
      runId: identity.workspaceId,
      intent: '{"command":"pwd"}',
      output: '',
      outputBytes: 0,
      cancelRequested: false,
    }).success,
  );
});
