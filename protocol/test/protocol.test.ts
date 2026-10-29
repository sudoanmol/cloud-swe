import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CancelRunRequest,
  CommandRecord,
  CreateSessionRequest,
  OperationReceipt,
  PageQuery,
  PiRuntime,
  RunState,
  Session,
  SessionEvent,
  SubmitMessageRequest,
  ToolOutcome,
} from '../src/index.ts';

const id = 'fa879d6e-bd71-48df-a621-f070c8df45da';
const now = '2026-10-29T12:00:00Z';

const capabilities = {
  submitMessage: true,
  cancelRun: true,
  tools: ['read', 'write', 'shell'],
  approvals: false,
  delegation: false,
};

const session = {
  id,
  engine: 'pi',
  target: 'cloud',
  runtime: { kind: 'pi-durable', conversationId: '1' },
  model: { provider: 'anthropic', id: 'configured-model' },
  workspace: { id, provider: 'boat', state: 'running' },
  capabilities,
  run: { kind: 'idle' },
  createdAt: now,
  updatedAt: now,
};

test('first-slice creation accepts only the implemented engine/target and no credentials', () => {
  const request = { operationId: id, engine: 'pi', target: 'cloud', workspaceId: id, model: session.model };
  assert.ok(CreateSessionRequest.safeParse(request).success);

  for (const extra of [{ engine: 'claude' }, { target: 'mac' }, { token: 'secret' }, { workspaceId: 'boat-id' }]) {
    assert.equal(CreateSessionRequest.safeParse({ ...request, ...extra }).success, false);
  }
});

test('application UUIDs remain distinct from native Pi conversation IDs', () => {
  assert.ok(PiRuntime.safeParse({ kind: 'pi-durable', conversationId: '1' }).success);
  assert.equal(PiRuntime.safeParse({ kind: 'pi-durable', conversationId: id }).success, false);
  assert.equal(Session.safeParse({ ...session, id: '1' }).success, false);
  assert.equal(PiRuntime.safeParse({ kind: 'pi-durable', conversationId: '0' }).success, false);
});

test('message admission preserves text and rejects invalid or unbounded input', () => {
  assert.equal(SubmitMessageRequest.parse({ operationId: id, text: '  hello  ' }).text, '  hello  ');

  for (const text of ['', ' \n\t', 'x'.repeat(64_001)]) {
    assert.equal(SubmitMessageRequest.safeParse({ operationId: id, text }).success, false);
  }

  assert.equal(SubmitMessageRequest.safeParse({ operationId: 'invalid', text: 'hello' }).success, false);
});

test('cancellation targets a run, and a receipt means admission rather than completion', () => {
  assert.ok(CancelRunRequest.safeParse({ operationId: id, runId: id }).success);
  assert.equal(CancelRunRequest.safeParse({ operationId: id }).success, false);
  const receipt = {
    operationId: id,
    sessionId: id,
    runId: id,
    action: 'submit_message',
    status: 'accepted',
    acceptedAt: now,
  };
  assert.ok(OperationReceipt.safeParse(receipt).success);
  assert.equal(OperationReceipt.safeParse({ ...receipt, status: 'completed' }).success, false);
});

test('unknown command outcomes cannot masquerade as success', () => {
  const identity = { workspaceId: id, runnerGeneration: id, operationId: id };
  assert.ok(CommandRecord.safeParse({ kind: 'uncertain', identity, reason: 'Launch receipt lost' }).success);
  assert.equal(CommandRecord.safeParse({ kind: 'exited', identity, jobId: '42', exitCode: null }).success, false);
  assert.equal(
    CommandRecord.safeParse({ kind: 'running', identity: { workspaceId: id, operationId: id }, jobId: '42' }).success,
    false,
  );
  assert.equal(ToolOutcome.safeParse({ kind: 'uncertain', reason: 'Lost connection' }).success, false);
  assert.equal(RunState.safeParse({ kind: 'idle', runId: id }).success, false);
  assert.equal(RunState.safeParse({ kind: 'running' }).success, false);
});

test('snapshot and tool upsert events round-trip as JSON for a native client', () => {
  const entry = {
    id,
    runId: id,
    createdAt: now,
    kind: 'tool',
    toolCallId: 'tool-1',
    name: 'shell',
    arguments: { command: 'pwd' },
    outcome: { kind: 'uncertain', operationId: id, reason: 'Receipt lost' },
  };

  const events = [
    { kind: 'snapshot', snapshot: { session, history: { entries: [entry], nextCursor: null } } },
    { kind: 'entry.upserted', sessionId: id, entry },
  ];

  for (const event of events) assert.deepEqual(SessionEvent.parse(JSON.parse(JSON.stringify(event))), event);
  assert.equal(
    SessionEvent.safeParse({ kind: 'session.updated', session: { ...session, createdAt: 'yesterday' } }).success,
    false,
  );
});

test('pagination validates URL query strings and bounds', () => {
  assert.deepEqual(PageQuery.parse({}), { limit: 50 });
  assert.deepEqual(PageQuery.parse({ limit: '10', cursor: 'opaque' }), { limit: 10, cursor: 'opaque' });

  for (const limit of ['0', '101', '1.5', 'nope', '']) assert.equal(PageQuery.safeParse({ limit }).success, false);
});
