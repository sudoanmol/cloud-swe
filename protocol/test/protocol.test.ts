/**
 * Path: protocol/test/protocol.test.ts
 * Used by: pnpm test.
 * Purpose: Contract tests for the session, message, history and credential schemas.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ATTACHMENT_LIMITS } from '../src/attachments.ts';
import {
  APP_REDIRECT_URI,
  ExchangeSignInCodeRequest,
  LoginQuery,
  ModelCredentialStatus,
  SetModelCredentialRequest,
  StoredModelCredential,
} from '../src/credentials.ts';
import {
  ApiError,
  CancelRunRequest,
  CancelRunResponse,
  CommandRecord,
  ContentBlock,
  ConversationId,
  ConversationParams,
  CreateSessionRequest,
  Entry,
  EntryId,
  EventsQuery,
  TemplateName,
  ListSessionsResponse,
  OperationReceipt,
  PageQuery,
  RenameSessionRequest,
  RunState,
  Session,
  SESSION_PREVIEW_LIMIT,
  SESSION_TITLE_LIMIT,
  sessionSummary,
  SessionSummary,
  sessionTitle,
  SessionEvent,
  Snapshot,
  SubmitMessageRequest,
  ToolOutcome,
} from '../src/index.ts';
import { CancelOperation, HistoryPosition, MessageOperation, WorkspaceEntry, WorkspaceRecord } from '../src/storage.ts';

const id = 'fa879d6e-bd71-48df-a621-f070c8df45da';
const now = '2026-10-29T12:00:00Z';

const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const session = {
  id,
  title: null,
  activeConversationId: '1',
  model: { provider: 'anthropic', id: 'configured-model' },
  workspace: { id, state: 'running' },
  environment: null,
  run: { kind: 'idle' },
  compaction: null,
  compactionFailure: null,
  pending: [],
  repos: [],
  approvals: [],
  pullRequests: [],
  questions: [],
  secretRequests: [],
  todos: [],
  usage: { ...tokens, totalTokens: 0, cost: { ...tokens, total: 0 } },
  createdAt: now,
  updatedAt: now,
};

test('creation rejects credentials and a client-chosen workspace', () => {
  const request = { operationId: id, template: 'base', model: session.model };
  assert.ok(CreateSessionRequest.safeParse(request).success);

  for (const extra of [{ token: 'secret' }, { workspaceId: id }]) {
    assert.equal(CreateSessionRequest.safeParse({ ...request, ...extra }).success, false);
  }

  // The server fills in its default template and model.
  assert.deepEqual(CreateSessionRequest.parse({ operationId: id }), { operationId: id });
});

test('clients name a template, never a sandbox or path', () => {
  for (const template of ['', 'bx_23456789/', '../base', 'a'.repeat(65), 'has space']) {
    assert.equal(TemplateName.safeParse(template).success, false);
  }

  assert.ok(TemplateName.safeParse('cloud-swe.v2').success);
});

test('sandbox identities stay server-side and are validated per backend', () => {
  const record = { id, sessionId: id, provider: 'e2b', sandboxId: 'sandbox-1' };
  assert.ok(WorkspaceRecord.safeParse(record).success);
  assert.equal(WorkspaceRecord.safeParse({ ...record, provider: 'other' }).success, false);
  assert.equal(WorkspaceRecord.safeParse({ ...record, sandboxId: '' }).success, false);

  const entry = { ...record, state: 'stopped', lastActiveAt: '2026-10-30T00:00:00.000Z' };
  assert.ok(WorkspaceEntry.safeParse(entry).success);
  assert.equal(WorkspaceEntry.safeParse({ ...entry, state: 'starting' }).success, false, 'starting is never stored');
  assert.ok(Session.safeParse({ ...session, workspace: { ...session.workspace, state: 'deleted' } }).success);
  assert.ok(ApiError.safeParse({ error: { code: 'sandbox_limit_reached', message: 'Limit reached' } }).success);
  assert.equal(
    Session.safeParse({ ...session, workspace: { ...session.workspace, sandboxId: 'bx_23456789' } }).success,
    false,
  );
});

test('a session shows no engine, provider or capability internals', () => {
  assert.equal(Session.safeParse({ ...session, id: '1' }).success, false);
  assert.equal(Session.safeParse({ ...session, runtime: { conversationId: '1' } }).success, false);
  assert.equal(
    Session.safeParse({ ...session, workspace: { ...session.workspace, provider: 'docker' } }).success,
    false,
  );
  assert.equal(Session.safeParse({ ...session, capabilities: {} }).success, false);
});

test('a title is the first line of the first message, trimmed and capped, and a rename follows the same limit', () => {
  assert.equal(sessionTitle('\n  Fix the login bug  \nIt fails on Safari'), 'Fix the login bug');
  assert.equal(sessionTitle('x'.repeat(SESSION_TITLE_LIMIT + 5)), 'x'.repeat(SESSION_TITLE_LIMIT));
  assert.ok(Session.safeParse({ ...session, title: 'Fix the login bug' }).success);
  assert.equal(Session.safeParse({ ...session, title: '' }).success, false);

  assert.deepEqual(RenameSessionRequest.parse({ title: '  Login  ' }), { title: 'Login' });

  for (const title of ['   ', 'x'.repeat(SESSION_TITLE_LIMIT + 1), null]) {
    assert.equal(RenameSessionRequest.safeParse({ title }).success, false);
  }
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
    conversationId: '1',
    runId: id,
    action: 'submit_message',
    status: 'accepted',
    acceptedAt: now,
  };

  const restored = [{ operationId: id, mode: 'followUp', text: 'keep this draft', attachments: [id] }];
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
    request: { operationId: id, mode: 'reject', text: 'hello' },
    model: session.model,
    receipt: {
      operationId: id,
      sessionId: id,
      conversationId: '1',
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
    withdrawnSystemIds: [id],
    receipt: {
      operationId: id,
      sessionId: id,
      conversationId: '1',
      runId: id,
      action: 'cancel_run',
      status: 'accepted',
      acceptedAt: now,
      restoredMessages: [],
    },
    state: 'prepared',
  };

  assert.ok(CancelOperation.safeParse(operation).success);
  assert.equal(CancelOperation.safeParse({ ...operation, withdrawnSystemIds: undefined }).success, false);
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

test('a snapshot with an uncertain tool outcome is a valid event as JSON', () => {
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
    snapshot: {
      conversationId: '1',
      session,
      history: { entries: [entry], nextCursor: null },
      live: { message: null, tools: [], toolsTruncated: false },
    },
  };

  assert.ok(SessionEvent.safeParse(JSON.parse(JSON.stringify(event))).success);
});

test('a session list row counts what waits on the user and opens the active conversation', () => {
  const approval = {
    id,
    repo: 'octo/hello',
    createdAt: now,
    kind: 'ref_change',
    ref: 'refs/tags/v1',
    sha: null,
    expected: null,
  };

  const parsed = Session.parse({
    ...session,
    approvals: [
      { ...approval, state: 'pending' },
      { ...approval, state: 'succeeded' },
    ],
  });

  const summary = sessionSummary(parsed, 'Fixed it');

  assert.equal(summary.openRequests, 1);
  assert.equal(summary.activeConversationId, '1');
  assert.ok(ListSessionsResponse.safeParse({ sessions: [summary], nextCursor: null }).success);
  assert.equal(SessionSummary.safeParse({ ...summary, preview: 'x'.repeat(SESSION_PREVIEW_LIMIT + 1) }).success, false);
  assert.equal(ListSessionsResponse.safeParse({ sessions: [parsed], nextCursor: null }).success, false);
});

test('conversation and attachment IDs are path-safe, and a message names at most three distinct uploads', () => {
  for (const bad of ['', 'a/b', '..', 'x'.repeat(65)]) assert.equal(ConversationId.safeParse(bad).success, false);
  assert.ok(ConversationParams.safeParse({ sessionId: id, conversationId: '42' }).success);

  const message = { operationId: id, text: 'see this' };
  const ids = Array.from({ length: ATTACHMENT_LIMITS.perMessage + 1 }, () => crypto.randomUUID());
  assert.ok(SubmitMessageRequest.safeParse({ ...message, attachments: ids.slice(1) }).success);
  assert.equal(SubmitMessageRequest.safeParse({ ...message, attachments: ids }).success, false);
  assert.equal(SubmitMessageRequest.safeParse({ ...message, attachments: [id, id] }).success, false);
  assert.equal(SubmitMessageRequest.safeParse({ ...message, attachments: ['nope'] }).success, false);
  assert.equal(SubmitMessageRequest.safeParse({ ...message, text: ' ', attachments: [id] }).success, false);

  assert.equal(ContentBlock.safeParse({ kind: 'image', attachmentId: id }).success, false, 'a client needs its type');
  assert.equal(ContentBlock.safeParse({ kind: 'image', attachmentId: id, mediaType: 'image/bmp' }).success, false);
  assert.equal(ContentBlock.safeParse({ kind: 'image', data: 'AAAA', mediaType: 'image/png' }).success, false);
});

test('the event stream resumes by entry ID and every delta event is well formed', () => {
  assert.deepEqual(EventsQuery.parse({ after: '42' }), { after: '42' });
  assert.deepEqual(EventsQuery.parse({}), {});
  assert.equal(EventsQuery.safeParse({ after: '' }).success, false);
  assert.equal(EventsQuery.safeParse({ cursor: '42' }).success, false);

  const live = { message: null, tools: [], toolsTruncated: false };
  assert.ok(SessionEvent.safeParse({ kind: 'live', live }).success);
  assert.ok(SessionEvent.safeParse({ kind: 'session', session }).success);
  assert.equal(SessionEvent.safeParse({ kind: 'entries', after: '1', entries: [] }).success, false, 'never empty');
  assert.equal(SessionEvent.safeParse({ kind: 'live', live: { ...live, message: { content: [] } } }).success, false);
  assert.equal(
    Entry.safeParse({
      id,
      createdAt: now,
      kind: 'message',
      role: 'assistant',
      content: [{ kind: 'text', text: 'hi' }],
      status: 'streaming',
    }).success,
    false,
    'a partial is live, never an entry',
  );
});

test('app sign-in takes an S256 challenge, and the exchange takes a one-time code with its verifier', () => {
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  const query = { redirect_uri: APP_REDIRECT_URI, code_challenge: challenge, code_challenge_method: 'S256' };
  assert.ok(LoginQuery.safeParse(query).success);
  assert.ok(LoginQuery.safeParse({}).success, 'the browser flow for command-line use stays');
  assert.equal(LoginQuery.safeParse({ ...query, code_challenge_method: 'plain' }).success, false);
  assert.equal(LoginQuery.safeParse({ ...query, code_challenge: `${challenge}=` }).success, false);
  assert.equal(LoginQuery.safeParse({ redirect_uri: APP_REDIRECT_URI }).success, false);

  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.ok(ExchangeSignInCodeRequest.safeParse({ code: challenge, codeVerifier: verifier }).success);

  for (const codeVerifier of [verifier.slice(1), 'x'.repeat(129), `${verifier}/`]) {
    assert.equal(ExchangeSignInCodeRequest.safeParse({ code: challenge, codeVerifier }).success, false);
  }
});

test('pagination validates URL query strings and bounds', () => {
  assert.deepEqual(PageQuery.parse({}), { limit: 50 });
  assert.deepEqual(PageQuery.parse({ limit: '10', cursor: 'opaque' }), { limit: 10, cursor: 'opaque' });

  for (const limit of ['0', '101', '1.5', 'nope', '']) assert.equal(PageQuery.safeParse({ limit }).success, false);
});

test('compaction progress and its last failure are optional, strict projections', () => {
  const compaction = { reason: 'overflow', blocking: true, attempt: 2, nextAttemptAt: now };
  const compactionFailure = { reason: 'threshold', code: 'unknown', message: 'Model request failed' };
  assert.ok(Session.safeParse({ ...session, compaction, compactionFailure }).success);
  assert.equal(Session.safeParse({ ...session, compaction: { ...compaction, attempt: 0 } }).success, false);
  assert.equal(Session.safeParse({ ...session, compaction: { ...compaction, error: 'raw' } }).success, false);
  assert.equal(
    Session.safeParse({ ...session, compactionFailure: { ...compactionFailure, error: 'raw' } }).success,
    false,
  );
});

test('history preserves native entries without inventing an app run identity', () => {
  const sessionId = crypto.randomUUID();

  const entry = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    kind: 'native',
    nativeKind: 'pi.compaction',
    payload: { summary: 'context' },
  };

  assert.ok(EntryId.safeParse('42').success && EntryId.safeParse('live').success);
  assert.equal(EntryId.safeParse('').success, false);
  assert.ok(Entry.safeParse(entry).success);
  assert.equal(Snapshot.safeParse({}).success, false);
  assert.ok(
    HistoryPosition.safeParse({ sessionId, conversationId: '1', native: { after: 42, order: 'descending' } }).success,
  );
  assert.equal(HistoryPosition.safeParse({ sessionId: '1', native: {} }).success, false);
});

test('keys are write-only, bounded and separate from credential metadata', () => {
  assert.deepEqual(SetModelCredentialRequest.parse({ key: '  private  ' }), { key: 'private' });

  for (const key of ['', '  ', 'x'.repeat(8193)])
    assert.equal(SetModelCredentialRequest.safeParse({ key }).success, false);
  assert.equal(
    ModelCredentialStatus.safeParse({ provider: 'anthropic', configured: true, source: 'client', key: 'private' })
      .success,
    false,
  );
  assert.equal(
    ModelCredentialStatus.safeParse({ provider: 'anthropic', configured: true, source: 'disabled' }).success,
    false,
  );
  assert.ok(StoredModelCredential.safeParse({ kind: 'disabled' }).success);
});
