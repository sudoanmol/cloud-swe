import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CancelRunRequest,
  CancelRunResponse,
  CommandRecord,
  CreateSessionRequest,
  EnvironmentName,
  ListSessionsResponse,
  OperationReceipt,
  PageQuery,
  PiRuntime,
  RunState,
  Session,
  SessionEvent,
  SubmitMessageRequest,
  ToolOutcome,
} from '../src/index.ts';
import { CancelOperation, MessageOperation, WorkspaceRecord } from '../src/storage.ts';
import { BoatApiError, BoatSandboxCreated, BoatSandboxList, DockerWorkspaceInfo } from '../src/workspace.ts';

const id = 'fa879d6e-bd71-48df-a621-f070c8df45da';
const now = '2026-10-29T12:00:00Z';

const capabilities = {
  submitMessage: true,
  steerMessage: true,
  queueMessage: true,
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
  pending: [],
  createdAt: now,
  updatedAt: now,
};

test('first-slice creation accepts only the implemented engine/target and no credentials', () => {
  const request = { operationId: id, engine: 'pi', target: 'cloud', environment: 'base', model: session.model };
  assert.ok(CreateSessionRequest.safeParse(request).success);

  for (const extra of [{ engine: 'claude' }, { target: 'mac' }, { token: 'secret' }, { workspaceId: id }]) {
    assert.equal(CreateSessionRequest.safeParse({ ...request, ...extra }).success, false);
  }
});

test('clients name an environment, never a sandbox or path', () => {
  for (const environment of ['', 'bx_23456789/', '../base', 'a'.repeat(65), 'has space']) {
    assert.equal(EnvironmentName.safeParse(environment).success, false);
  }

  assert.ok(EnvironmentName.safeParse('cloud-swe.v2').success);
});

test('sandbox identities stay server-side and are validated per backend', () => {
  const record = { id, sessionId: id, provider: 'boat', sandboxId: 'bx_23456789' };
  assert.ok(WorkspaceRecord.safeParse(record).success);
  assert.equal(WorkspaceRecord.safeParse({ ...record, sandboxId: '' }).success, false);
  assert.equal(
    Session.safeParse({ ...session, workspace: { ...session.workspace, sandboxId: 'bx_23456789' } }).success,
    false,
  );
  assert.ok(
    BoatSandboxCreated.safeParse({ ok: true, type: 'sandbox.created', sandbox: { id: 'bx_23456789' } }).success,
  );
  assert.equal(
    BoatSandboxCreated.safeParse({ ok: true, type: 'sandbox.created', sandbox: { id: 'other' } }).success,
    false,
  );
  assert.ok(
    DockerWorkspaceInfo.safeParse({ provider: 'docker', id, state: 'running', root: `/workspace/${id}` }).success,
  );
  assert.equal(
    DockerWorkspaceInfo.safeParse({ provider: 'docker', id, state: 'running', root: '/workspace' }).success,
    false,
  );
});

test('sandbox recovery validates identities and requires pagination metadata', () => {
  const response = {
    ok: true,
    type: 'sandbox.list',
    sandboxes: [{ id: 'bx_23456789', name: 'cloud-swe-' + id }],
    pageInfo: { hasMore: false },
  };

  assert.ok(BoatSandboxList.safeParse(response).success);
  assert.equal(BoatSandboxList.safeParse({ ...response, pageInfo: undefined }).success, false);
  assert.equal(BoatSandboxList.safeParse({ ...response, sandboxes: [{ id: 'bad', name: 'test' }] }).success, false);
});

test('Boat error envelopes validate a code, not arbitrary message text', () => {
  assert.deepEqual(BoatApiError.parse({ ok: false, error: { code: 'idempotency_in_progress', message: 'Creating' } }), {
    ok: false,
    error: { code: 'idempotency_in_progress' },
  });

  for (const raw of [
    {},
    { ok: false, error: { code: 409 } },
    { ok: true, error: { code: 'idempotency_in_progress' } },
  ]) {
    assert.equal(BoatApiError.safeParse(raw).success, false);
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

test('submission mode defaults to reject and explicitly selects native steering or FIFO follow-up', () => {
  assert.equal(SubmitMessageRequest.parse({ operationId: id, text: 'hello' }).mode, 'reject');

  for (const mode of ['steer', 'followUp']) {
    assert.equal(SubmitMessageRequest.parse({ operationId: id, text: 'hello', mode }).mode, mode);
  }

  assert.equal(SubmitMessageRequest.safeParse({ operationId: id, text: 'hello', mode: 'queue' }).success, false);
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

  const restored = [{ operationId: id, mode: 'followUp', text: 'keep this draft' }];
  assert.deepEqual(
    CancelRunResponse.parse({ ...receipt, action: 'cancel_run', restoredMessages: restored }).restoredMessages,
    restored,
  );
  assert.equal(CancelRunResponse.safeParse({ ...receipt, restoredMessages: restored }).success, false);
  assert.ok(OperationReceipt.safeParse(receipt).success);
  assert.equal(OperationReceipt.safeParse({ ...receipt, status: 'completed' }).success, false);
});

test('message intents retain text and model identity separately from confirmed admission', () => {
  const operation = {
    request: { operationId: id, text: 'hello' },
    model: session.model,
    receipt: {
      operationId: id,
      sessionId: id,
      runId: id,
      action: 'submit_message',
      status: 'accepted',
      acceptedAt: now,
    },
    state: 'prepared',
  };

  assert.ok(MessageOperation.safeParse(operation).success);
  assert.ok(MessageOperation.safeParse({ ...operation, state: 'accepted' }).success);
  assert.equal(MessageOperation.safeParse({ ...operation, model: undefined }).success, false);
  assert.equal(
    MessageOperation.safeParse({ ...operation, receipt: { ...operation.receipt, action: 'cancel_run' } }).success,
    false,
  );
});

test('cancellation intents bind a receipt to a run and its native message operation', () => {
  const operation = {
    request: { operationId: id, runId: id },
    messageOperationIds: [id],
    receipt: { operationId: id, sessionId: id, runId: id, action: 'cancel_run', status: 'accepted', acceptedAt: now },
    state: 'prepared',
  };

  assert.ok(CancelOperation.safeParse(operation).success);
  assert.equal(CancelOperation.safeParse({ ...operation, messageOperationIds: [] }).success, false);
  assert.equal(
    CancelOperation.safeParse({ ...operation, receipt: { ...operation.receipt, action: 'submit_message' } }).success,
    false,
  );
});

test('unknown command outcomes cannot masquerade as success', () => {
  const identity = { workspaceId: id, operationId: id };
  const open = { identity, cancelRequested: false, heartbeat: 0, lastSeenAt: 0, output: '', outputBytes: 0 };
  assert.ok(CommandRecord.safeParse({ ...open, kind: 'uncertain', reason: 'Launch receipt lost' }).success);
  assert.equal(CommandRecord.safeParse({ kind: 'exited', identity, exitCode: null }).success, false);
  assert.equal(ToolOutcome.safeParse({ kind: 'uncertain', reason: 'Lost connection' }).success, false);
  assert.equal(RunState.safeParse({ kind: 'idle', runId: id }).success, false);
  assert.equal(RunState.safeParse({ kind: 'running' }).success, false);
});

test('snapshot events round-trip as JSON for a native client', () => {
  const entry = {
    id,
    createdAt: now,
    kind: 'tool',
    toolCallId: 'tool-1',
    parentToolCallId: null,
    taskId: null,
    nestedCalls: [],
    name: 'shell',
    arguments: { command: 'pwd' },
    outcome: { kind: 'uncertain', operationId: id, reason: 'Receipt lost' },
  };

  const event = {
    kind: 'snapshot',
    snapshot: { session, history: { entries: [entry], nextCursor: null }, tools: [], toolsTruncated: false },
  };

  assert.deepEqual(SessionEvent.parse(JSON.parse(JSON.stringify(event))), event);
  assert.equal(SessionEvent.safeParse({ kind: 'entry.upserted', sessionId: id, entry }).success, false);
});

test('a session list names the sessions it could not read instead of dropping them', () => {
  const page = { sessions: [], nextCursor: null, unavailable: [id] };

  assert.deepEqual(ListSessionsResponse.parse(page), page);
  assert.equal(ListSessionsResponse.safeParse({ sessions: [], nextCursor: null }).success, false);
});

test('pagination validates URL query strings and bounds', () => {
  assert.deepEqual(PageQuery.parse({}), { limit: 50 });
  assert.deepEqual(PageQuery.parse({ limit: '10', cursor: 'opaque' }), { limit: 10, cursor: 'opaque' });

  for (const limit of ['0', '101', '1.5', 'nope', '']) assert.equal(PageQuery.safeParse({ limit }).success, false);
});
