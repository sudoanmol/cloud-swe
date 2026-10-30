import assert from 'node:assert/strict';
import test from 'node:test';

import { MessageOperation } from '@cloud-swe/protocol/storage';

import { cancellationScope } from '../src/sessions/cancellation.ts';

function pending(status: 'queued' | 'running') {
  const operationId = crypto.randomUUID();

  const operation = MessageOperation.parse({
    request: { operationId, mode: 'followUp', text: operationId },
    model: { provider: 'anthropic', id: 'claude-sonnet-5-5' },
    receipt: {
      operationId,
      sessionId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      action: 'submit_message',
      status: 'accepted',
      acceptedAt: new Date().toISOString(),
    },
    state: 'accepted',
  });

  return { operation, status };
}

test('a cancelled uncertain run stays in scope while other inputs are pending', () => {
  // A target that settled natively but owns unresolved remote work is not in the pending list.
  const target = pending('running');
  const queued = pending('queued');

  assert.deepEqual(cancellationScope(target, [queued]), [target, queued]);
});

test('a placed input takes the pending scope and a queued input is withdrawn alone', () => {
  const running = pending('running');
  const queued = pending('queued');

  assert.deepEqual(cancellationScope(running, [running, queued]), [running, queued]);
  assert.deepEqual(cancellationScope(queued, [running, queued]), [queued]);
  assert.deepEqual(cancellationScope(running, []), [running]);
});
