/**
 * Path: protocol/test/fixtures.test.ts
 * Used by: pnpm test.
 * Purpose: One JSON sample per response, event kind and union variant, as the schemas produce it, checked byte for byte against protocol/fixtures/, which the Swift client's tests decode. `pnpm --filter @cloud-swe/protocol fixtures` rewrites them.
 */

import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { z } from 'zod';

import { Attachment } from '../src/attachments.ts';
import { AuthToken, ModelCredentialStatus } from '../src/credentials.ts';
import { EnvironmentView, ListEnvironmentsResponse, SecretRequest } from '../src/environments.ts';
import {
  ApiError,
  CancelRunResponse,
  ContentBlock,
  CreateSessionResponse,
  Entry,
  HistoryResponse,
  ListSessionsResponse,
  OperationReceipt,
  RewindReceipt,
  RunState,
  Session,
  SessionEvent,
  sessionSummary,
  Snapshot,
  ToolOutcome,
} from '../src/index.ts';
import { Question } from '../src/interaction.ts';

const DIR = new URL('../fixtures/', import.meta.url);

// Fixed values, so a run reproduces every file exactly.
const at = '2026-11-16T09:30:00.000Z';
const later = '2026-11-16T09:31:00.000Z';
const sessionId = '0b9a5c1e-7d2f-4e8a-9b3c-5d6e7f8a9b0c';
const workspaceId = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const operationId = '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a';
const runId = '3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b';
const attachmentId = '4f5a6b7c-8d9e-4f0a-9b2c-3d4e5f6a7b8c';
const queuedId = '5a6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c9d';

const text = { kind: 'text', text: 'The test fails because the token expired.' };
const image = { kind: 'image', attachmentId, mediaType: 'image/png' };
const toolCall = { kind: 'tool_call', toolCallId: 'toolu_01', name: 'bash', arguments: { command: 'pnpm test' } };

const runStates = {
  idle: { kind: 'idle' },
  running: { kind: 'running', runId },
  cancelling: { kind: 'cancelling', runId },
  completed: { kind: 'completed', runId },
  cancelled: { kind: 'cancelled', runId },
  retrying: { kind: 'retrying', runId, code: 'overloaded', message: 'The model is overloaded.', nextAttemptAt: later },
  failed: { kind: 'failed', runId, code: 'rate_limited', message: 'The model is rate limited.' },
  uncertain: { kind: 'uncertain', runId, operationId, reason: 'The sandbox stopped answering.' },
};

const toolOutcomes = {
  unavailable: { kind: 'unavailable', reason: 'Native tool ended without a readable result' },
  pending: { kind: 'pending' },
  running: { kind: 'running', output: 'Running 12 tests' },
  succeeded: { kind: 'succeeded', output: '12 passed' },
  failed: { kind: 'failed', message: 'Command exited with code 1', output: '1 failed' },
  interrupted: { kind: 'interrupted', reason: 'The run was cancelled', output: '3 passed' },
  uncertain: { kind: 'uncertain', operationId, reason: 'Remote command interruption is not confirmed', output: '' },
};

const tool = {
  toolCallId: 'toolu_01',
  parentToolCallId: null,
  taskId: '7',
  name: 'bash',
  arguments: { command: 'pnpm test' },
  outcome: toolOutcomes.succeeded,
  nestedCalls: [],
};

const entries = {
  native: { id: '3', createdAt: at, kind: 'native', nativeKind: 'pi.compaction', payload: { summary: 'Earlier work' } },
  message: { id: '4', createdAt: at, kind: 'message', role: 'user', content: [text, image], status: 'committed' },
  tool: { id: '5', createdAt: later, kind: 'tool', ...tool },
};

const question = {
  id: '7c8d9e0f-1a2b-4c3d-8e5f-6a7b8c9d0e1f',
  questions: [
    {
      question: 'Which cache should the service use?',
      header: 'Cache',
      options: [
        { label: 'Redis', description: 'Shared between instances' },
        { label: 'LRU', description: 'In process' },
      ],
      multiSelect: false,
    },
  ],
  createdAt: at,
};

const questions = {
  pending: { ...question, state: 'pending' },
  answered: {
    ...question,
    state: 'answered',
    answers: [{ questionIndex: 0, selected: ['LRU'] }],
    decidedAt: later,
  },
  declined: { ...question, state: 'declined', decidedAt: later },
};

const secretRequest = {
  id: '8d9e0f1a-2b3c-4d4e-9f6a-7b8c9d0e1f2a',
  environment: 'dev',
  name: 'OPENAI_API_KEY',
  hosts: ['api.openai.com'],
  header: 'Authorization',
  reason: 'To call the model in the integration tests',
  state: 'pending',
  createdAt: at,
};

const credentialStatuses = {
  client: { provider: 'anthropic', source: 'client', configured: true },
  worker: { provider: 'anthropic', source: 'worker', configured: true },
  disabled: { provider: 'anthropic', source: 'disabled', configured: false },
  none: { provider: 'anthropic', source: 'none', configured: false },
};

const session = Session.parse({
  id: sessionId,
  title: 'Fix the login bug',
  activeConversationId: '1',
  model: { provider: 'anthropic', id: 'claude-sonnet-5-5' },
  workspace: { id: workspaceId, state: 'running' },
  environment: 'dev',
  run: runStates.running,
  compaction: null,
  compactionFailure: null,
  pending: [
    { operationId, runId, mode: 'followUp', status: 'queued', text: 'Then run lint', attachments: [attachmentId] },
  ],
  repos: [{ url: 'https://github.com/octo/hello', path: 'hello', base: true }],
  questions: [questions.pending],
  secretRequests: [secretRequest],
  todos: [
    {
      id: 1,
      subject: 'Fix the token check',
      activeForm: 'Fixing the token check',
      status: 'in_progress',
      blockedBy: [],
    },
  ],
  usage: {
    input: 1200,
    output: 3400,
    cacheRead: 52_000,
    cacheWrite: 8000,
    totalTokens: 64_600,
    cost: { input: 0.0036, output: 0.051, cacheRead: 0.0156, cacheWrite: 0.03, total: 0.1002 },
  },
  createdAt: at,
  updatedAt: later,
});

const live = {
  message: { createdAt: later, content: [text] },
  tools: [{ ...tool, outcome: toolOutcomes.running }],
  toolsTruncated: false,
};

const history = { entries: Object.values(entries), nextCursor: 'eyJzZXNzaW9uSWQiOiIuLi4ifQ' };
const snapshot = { conversationId: '1', session, history, live };
const receipt = { operationId, sessionId, conversationId: '1', runId, status: 'accepted', acceptedAt: at };

type Sample = readonly [z.ZodType, unknown];

const variants = <V>(name: string, schema: z.ZodType, values: Readonly<Record<string, V>>) =>
  Object.entries(values).map(([variant, value]): [string, Sample] => [`${name}.${variant}`, [schema, value]]);

const FIXTURES = new Map<string, Sample>([
  ['ApiError', [ApiError, { error: { code: 'session_not_found', message: "That session doesn't exist." } }]],
  ['Session', [Session, session]],
  ['CreateSessionResponse', [CreateSessionResponse, { operationId, session }]],
  [
    'ListSessionsResponse',
    [ListSessionsResponse, { sessions: [sessionSummary(session, 'Fixed the token check.')], nextCursor: null }],
  ],
  ['OperationReceipt', [OperationReceipt, { ...receipt, action: 'submit_message' }]],
  [
    'CancelRunResponse',
    [
      CancelRunResponse,
      {
        ...receipt,
        operationId: queuedId,
        action: 'cancel_run',
        restoredMessages: [{ operationId, mode: 'followUp', text: 'Then run lint', attachments: [attachmentId] }],
      },
    ],
  ],
  [
    'RewindReceipt',
    [
      RewindReceipt,
      {
        operationId,
        sessionId,
        conversationId: '231',
        action: 'rewind_conversation',
        status: 'accepted',
        acceptedAt: at,
      },
    ],
  ],
  ['HistoryResponse', [HistoryResponse, history]],
  ['Snapshot', [Snapshot, snapshot]],
  ['Attachment', [Attachment, { id: attachmentId, mediaType: 'image/png', bytes: 482_113 }]],
  ['AuthToken', [AuthToken, { token: 'bearer-token-from-sign-in' }]],
  ['SecretRequest', [SecretRequest, secretRequest]],
  [
    'EnvironmentView',
    [
      EnvironmentView,
      {
        name: 'dev',
        variables: {
          DATABASE_URL: { value: 'postgres://localhost/dev', updatedAt: at, updatedBy: { kind: 'client' } },
        },
        networkSecrets: { OPENAI_API_KEY: { hosts: ['api.openai.com'], header: 'Authorization', updatedAt: at } },
        createdAt: at,
        updatedAt: at,
      },
    ],
  ],
  ['ListEnvironmentsResponse', [ListEnvironmentsResponse, { environments: [] }]],
  ...variants('RunState', RunState, runStates),
  ...variants('ContentBlock', ContentBlock, {
    text,
    reasoning: { kind: 'reasoning', text: 'Check the expiry.' },
    tool_call: toolCall,
    image,
  }),
  ...variants('ToolOutcome', ToolOutcome, toolOutcomes),
  ...variants('Entry', Entry, entries),
  ...variants('SessionEvent', SessionEvent, {
    snapshot: { kind: 'snapshot', snapshot },
    session: { kind: 'session', session },
    entries: { kind: 'entries', after: '4', entries: [entries.tool] },
    live: { kind: 'live', live },
  }),
  ...variants('Question', Question, questions),
  ...variants('ModelCredentialStatus', ModelCredentialStatus, credentialStatuses),
]);

// Key order is the schema's and every value is fixed, so the text is the same on every run.
const rendered = new Map(
  [...FIXTURES].map(([name, [schema, value]]) => [`${name}.json`, `${JSON.stringify(schema.parse(value), null, 2)}\n`]),
);

test('every variant of every client-facing union has a fixture', () => {
  const unions = {
    RunState,
    ContentBlock,
    ToolOutcome,
    Entry,
    SessionEvent,
    Question,
    ModelCredentialStatus,
  };

  for (const [name, union] of Object.entries(unions)) {
    const { discriminator } = union.def;

    const covered = [...FIXTURES].flatMap(([key, [, value]]) =>
      key.startsWith(`${name}.`) ? [[key, z.looseObject({}).parse(value)[discriminator]]] : [],
    );

    for (const [key, tag] of covered)
      assert.equal(key, `${name}.${String(tag)}`, 'a variant fixture is named by its tag');
    assert.equal(covered.length, union.options.length, `${name} has a variant without a fixture`);
  }
});

test('the committed fixtures are what the schemas produce', async () => {
  if (process.env.UPDATE_FIXTURES === '1') {
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR);

    for (const [file, json] of rendered) await writeFile(new URL(file, DIR), json);
  }

  const hint = 'run `pnpm --filter @cloud-swe/protocol fixtures` and commit protocol/fixtures/';
  assert.deepEqual((await readdir(DIR)).sort(), [...rendered.keys()].sort(), hint);

  for (const [file, json] of rendered)
    assert.equal(await readFile(new URL(file, DIR), 'utf8'), json, `${file}: ${hint}`);
});
