import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { CommandIdentity } from '@cloud-swe/protocol';
import { ShellProgress } from '@cloud-swe/protocol/tools';

import { commandPrefix, supervisorCommand } from '../src/tools/runner.ts';

// Runs the real supervisor script locally. A 600 s test would prove the same thing slowly: the old limit was a
// default timer, so a command with no timeout must end by exit alone and one with a timeout must still be stopped.
function supervise(command: string, timeoutSeconds?: number) {
  const identity = CommandIdentity.parse({ workspaceId: crypto.randomUUID(), operationId: crypto.randomUUID() });

  const run = spawnSync('bash', ['-c', supervisorCommand(identity, { command, cwd: '/tmp', timeoutSeconds })], {
    timeout: 20_000,
  });

  assert.equal(run.status, 0, run.stderr.toString());

  return ShellProgress.parse(JSON.parse(readFileSync(commandPrefix(identity) + '.json', 'utf8')));
}

test('a command without a timeout runs to its own exit; one with a timeout is stopped', () => {
  const free = supervise('sleep 2; printf finished');
  assert.equal(free.kind, 'exited');

  if (free.kind === 'exited') assert.deepEqual([free.termination, free.exitCode, free.output], ['exit', 0, 'finished']);

  const bounded = supervise('sleep 10', 1);
  assert.equal(bounded.kind, 'exited');

  if (bounded.kind === 'exited') assert.equal(bounded.termination, 'timeout');
});
