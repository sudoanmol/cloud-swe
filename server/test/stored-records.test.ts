/**
 * Path: server/test/stored-records.test.ts
 * Used by: pnpm test.
 * Purpose: Rows exactly as production stored them before records were versioned (version 0) read through the current code, upgrade on read, and project to the public shapes clients get.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CancelRunResponse, CreateSessionRequest, OperationReceipt } from '@cloud-swe/protocol';
import {
  ConversationPointers,
  repoView,
  SessionCreation,
  sessionView,
  StoredQuestion,
  StoredSecretRequest,
  StoredSessionSummary,
} from '@cloud-swe/protocol/storage';
import type { z } from 'zod';

import { readAccess } from '../src/git/access.ts';
import { readRepos } from '../src/git/repos.ts';
import {
  fillSummaries,
  listSummaries,
  readCreation,
  readSessionCreation,
  readWorkspace,
  writeSummary,
} from '../src/sessions/catalog-store.ts';
import { sameRequest } from '../src/sessions/idempotency.ts';
import { readParsed } from '../src/storage.ts';
import {
  currentCancellation,
  currentMessageId,
  readCancellation,
  readMessage,
  readSession,
  writeSession,
} from '../src/thread-store.ts';
import { questionProjection } from '../src/tools/questions.ts';
import { secretRequestProjection } from '../src/tools/secret-requests.ts';
import { memoryStorage } from './fakes.ts';

// Captured 2026-11-16 by parsing realistic inputs with the schemas the deployed code stores with. Do not edit: these
// are what production holds.
const V0 = {
  session: {
    id: '6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d',
    runtime: {
      conversationId: '1',
    },
    model: {
      provider: 'anthropic',
      id: 'claude-sonnet-5-5',
    },
    workspace: {
      id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      provider: 'e2b',
      state: 'running',
    },
    environment: 'dev',
    capabilities: {
      submitMessage: false,
      steerMessage: false,
      queueMessage: false,
      cancelRun: false,
      tools: [],
      approvals: false,
      delegation: false,
    },
    run: {
      kind: 'idle',
    },
    compaction: null,
    compactionFailure: null,
    pending: [],
    repos: [],
    approvals: [],
    pullRequests: [],
    questions: [],
    secretRequests: [],
    todos: [],
    createdAt: '2026-11-10T09:30:00.000Z',
    updatedAt: '2026-11-10T09:30:00.000Z',
  },
  creation: {
    request: {
      operationId: 'e82d700b-576c-4d17-b2f5-ef33ca24c5e3',
      template: 'cloud-swe',
      environment: 'dev',
      repo: {
        url: 'https://github.com/octo/hello',
        branch: 'main',
      },
      model: {
        provider: 'anthropic',
        id: 'claude-sonnet-5-5',
      },
    },
    sessionId: '6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d',
    workspaceId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    createdAt: '2026-11-10T09:30:00.000Z',
  },
  plainCreation: {
    request: {
      operationId: 'e82d700b-576c-4d17-b2f5-ef33ca24c5e3',
      template: 'cloud-swe',
      model: {
        provider: 'anthropic',
        id: 'claude-sonnet-5-5',
      },
    },
    sessionId: '6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d',
    workspaceId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    createdAt: '2026-11-10T09:30:00.000Z',
  },
  workspace: {
    id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    sessionId: '6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d',
    provider: 'e2b',
    sandboxId: 'i8x2k4m6',
    state: 'running',
    lastActiveAt: '2026-11-10T09:30:00.000Z',
  },
  deleting: {
    id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    sessionId: '6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d',
    provider: 'e2b',
    sandboxId: 'i8x2k4m6',
    state: 'deleted',
    deletePending: true,
    lastActiveAt: '2026-11-10T09:30:00.000Z',
  },
  message: {
    request: {
      operationId: 'e82d700b-576c-4d17-b2f5-ef33ca24c5e3',
      mode: 'reject',
      text: 'Fix the failing test',
    },
    model: {
      provider: 'anthropic',
      id: 'claude-sonnet-5-5',
    },
    receipt: {
      operationId: 'e82d700b-576c-4d17-b2f5-ef33ca24c5e3',
      sessionId: '6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d',
      runId: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
      action: 'submit_message',
      status: 'accepted',
      acceptedAt: '2026-11-10T09:30:00.000Z',
    },
    state: 'accepted',
  },
  followUp: {
    request: {
      operationId: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
      mode: 'followUp',
      text: 'Approval x is succeeded.',
    },
    model: {
      provider: 'anthropic',
      id: 'claude-sonnet-5-5',
    },
    receipt: {
      operationId: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
      sessionId: '6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d',
      runId: 'e82d700b-576c-4d17-b2f5-ef33ca24c5e3',
      action: 'submit_message',
      status: 'accepted',
      acceptedAt: '2026-11-10T09:30:00.000Z',
    },
    state: 'prepared',
    notice: 'The sandbox was replaced.',
    system: true,
  },
  cancel: {
    request: {
      operationId: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
      runId: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
    },
    messageOperationIds: ['e82d700b-576c-4d17-b2f5-ef33ca24c5e3', '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e'],
    withdrawnSystemIds: [],
    receipt: {
      operationId: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
      sessionId: '6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d',
      runId: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
      action: 'cancel_run',
      status: 'accepted',
      acceptedAt: '2026-11-10T09:30:00.000Z',
      restoredMessages: [
        {
          operationId: 'e82d700b-576c-4d17-b2f5-ef33ca24c5e3',
          mode: 'followUp',
          text: 'Then run lint',
        },
      ],
    },
    state: 'accepted',
  },
  questions: [
    {
      question: {
        id: '44444444-4444-4444-8444-444444444444',
        questions: [
          {
            question: 'Which cache?',
            header: 'Cache',
            options: [
              {
                label: 'Redis',
                description: 'Shared',
                preview: 'redis()',
              },
              {
                label: 'LRU',
                description: 'In process',
              },
            ],
            multiSelect: false,
          },
        ],
        createdAt: '2026-11-10T09:30:00.000Z',
        state: 'pending',
      },
      delivered: false,
    },
    {
      question: {
        id: '55555555-5555-4555-8555-555555555555',
        questions: [
          {
            question: 'Which cache?',
            header: 'Cache',
            options: [
              {
                label: 'Redis',
                description: 'Shared',
                preview: 'redis()',
              },
              {
                label: 'LRU',
                description: 'In process',
              },
            ],
            multiSelect: false,
          },
        ],
        createdAt: '2026-11-10T09:30:00.000Z',
        state: 'answered',
        answers: [
          {
            questionIndex: 0,
            selected: ['LRU'],
            notes: 'keep it small',
          },
        ],
        globalNote: 'thanks',
        decidedAt: '2026-11-10T09:30:00.000Z',
      },
      delivered: true,
    },
  ],
  secretRequests: [
    {
      request: {
        id: '66666666-6666-4666-8666-666666666666',
        environment: 'dev',
        name: 'OPENAI_API_KEY',
        hosts: ['api.openai.com'],
        header: 'Authorization',
        reason: 'To call the model in tests',
        state: 'pending',
        createdAt: '2026-11-10T09:30:00.000Z',
      },
      delivered: false,
    },
    {
      request: {
        id: '77777777-7777-4777-8777-777777777777',
        environment: 'dev',
        name: 'STRIPE_KEY',
        hosts: ['api.stripe.com'],
        header: 'Authorization',
        reason: 'Payments',
        state: 'provided',
        confirmedHosts: ['api.stripe.com'],
        createdAt: '2026-11-10T09:30:00.000Z',
        decidedAt: '2026-11-10T09:30:00.000Z',
      },
      delivered: true,
    },
  ],
  repos: [
    {
      url: 'https://github.com/octo/hello',
      path: 'hello',
      base: true,
    },
    {
      url: 'https://gitlab.com/group/tool',
      path: 'tool',
      base: false,
    },
  ],
  gitAccess: {
    tokens: [
      {
        hash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        expiresAt: 1793000000000,
      },
    ],
  },
};

const sessionId = V0.session.id;
const op = V0.creation.request.operationId;
const run = V0.message.receipt.runId;

function storage() {
  return memoryStorage(
    new Map<string, unknown>([
      ['session', V0.session],
      [`operation:${op}`, V0.creation],
      [`id:${sessionId}`, V0.plainCreation],
      [`workspace:${V0.workspace.id}`, V0.workspace],
      [`message:${op}`, V0.message],
      [`message:${run}`, V0.followUp],
      [`cancel:${run}`, V0.cancel],
      ...V0.questions.map((row): [string, unknown] => [`question:${row.question.id}`, row]),
      ...V0.secretRequests.map((row): [string, unknown] => [`secretRequest:${row.request.id}`, row]),
      ['repos', V0.repos],
      ['gitAccess', V0.gitAccess],
    ]),
  );
}

test('version-0 Thread and Catalog rows read through the current code', async () => {
  const rows = storage();

  // Version 1 added the title; the public-only fields drop out.
  assert.deepEqual(await readSession(rows), {
    id: sessionId,
    runtime: V0.session.runtime,
    model: V0.session.model,
    workspace: { id: V0.session.workspace.id },
    environment: 'dev',
    title: null,
    createdAt: V0.session.createdAt,
    version: 1,
  });

  // Version 1 lifted the template and model out of the request, which keeps what the client sent.
  const lifted = { template: 'cloud-swe', model: V0.creation.request.model, version: 1 };
  const creation = await readCreation(rows, op);
  assert.deepEqual(creation, { ...V0.creation, ...lifted });
  assert.deepEqual(await readSessionCreation(rows, sessionId), { ...V0.plainCreation, ...lifted });
  assert.deepEqual(await readWorkspace(rows, V0.workspace.id), { ...V0.workspace, version: 0 });
  assert.deepEqual(await readAccess(rows), { ...V0.gitAccess, version: 0 });

  // A retry of a creation made before versions, with the same body, is the same request.
  const resent = CreateSessionRequest.parse({
    ...V0.creation.request,
    repo: { url: 'https://github.com/Octo/Hello.git', branch: 'main' },
  });

  assert.ok(creation && sameRequest(creation.request, SessionCreation.shape.request.parse(resent)));

  // Version 1 put the conversation on receipts: before then every session had only Pi's root conversation.
  const root = { conversationId: '1' };
  const message = await readMessage(rows, op);
  assert.deepEqual(message, { ...V0.message, receipt: { ...V0.message.receipt, ...root }, version: 1 });
  assert.deepEqual(OperationReceipt.parse(message?.receipt), { ...V0.message.receipt, ...root });

  assert.deepEqual(await readMessage(rows, run), {
    ...V0.followUp,
    receipt: { ...V0.followUp.receipt, ...root },
    version: 1,
  });

  const cancel = await readCancellation(rows, run);
  assert.deepEqual(cancel, { ...V0.cancel, receipt: { ...V0.cancel.receipt, ...root }, version: 1 });

  assert.deepEqual(CancelRunResponse.parse(cancel?.receipt), {
    ...V0.cancel.receipt,
    ...root,
    restoredMessages: V0.cancel.receipt.restoredMessages.map((restored) => ({ ...restored, attachments: [] })),
  });
});

test('an upgraded row is what the next write stores; a current row is not upgraded again; a newer one fails', async () => {
  const rows = storage();
  const upgraded = await readSession(rows);
  assert.ok(upgraded);
  await writeSession(rows, { ...upgraded, title: 'Named' });

  assert.deepEqual(rows.rows.get('session'), { ...upgraded, title: 'Named' });
  assert.equal((await readSession(rows))?.title, 'Named');

  rows.rows.set('session', { ...upgraded, version: 2 });
  await assert.rejects(readSession(rows));
});

test('version-0 rows project to the public shapes clients get', async () => {
  const rows = storage();

  const [pending, answered] = V0.questions.map((row) => row.question);
  assert.ok(pending && answered);

  assert.deepEqual(await questionProjection(rows), [
    pending,
    {
      ...answered,
      questions: answered.questions.map((item) => ({
        ...item,
        options: item.options.map(({ label, description }) => ({ label, description })),
      })),
    },
  ]);

  assert.deepEqual(
    await secretRequestProjection(rows),
    V0.secretRequests.map((row) => row.request),
  );

  assert.deepEqual((await readRepos(rows)).map(repoView), V0.repos);

  const stored = await readSession(rows);
  assert.ok(stored);

  const workspaceState = 'stopped';

  // The session as a client sees it: its active conversation, no provider, capabilities, approvals or pull requests, and
  // no title yet.
  const { runtime, capabilities: _capabilities, approvals: _approvals, pullRequests: _pulls, ...shown } = V0.session;
  const { id: _id, workspace, environment: _environment, createdAt: _createdAt, ...live } = shown;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const usage = { ...tokens, totalTokens: 0, cost: { ...tokens, total: 0 } };

  assert.deepEqual(sessionView(stored, { ...live, run: { kind: 'idle' }, usage, workspaceState }), {
    ...shown,
    title: null,
    activeConversationId: runtime.conversationId,
    usage,
    workspace: { id: workspace.id, state: workspaceState },
  });
});

// Captured 2026-11-16: before conversations were addressable, each pointer key held one bare operation ID. Do not edit.
const SINGLE_POINTERS = {
  currentMessage: 'e82d700b-576c-4d17-b2f5-ef33ca24c5e3',
  currentCancellation: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
};

test("a single current-message or current-cancellation pointer reads as the first conversation's", async () => {
  const rows = storage();

  for (const [key, id] of Object.entries(SINGLE_POINTERS)) rows.rows.set(key, id);

  assert.equal(await currentMessageId(rows, '1'), op);
  assert.equal(await currentMessageId(rows, '2'), undefined);
  assert.deepEqual(await currentCancellation(rows, '1'), await readCancellation(rows, run));
  assert.equal(await currentCancellation(rows, '2'), undefined);

  // What the next write stores: the map, with the first conversation's pointer kept beside another's.
  const upgraded = ConversationPointers.parse(SINGLE_POINTERS.currentMessage);
  assert.deepEqual(upgraded, { conversations: { '1': op }, version: 0 });

  const both = { conversations: { ...upgraded.conversations, '2': run }, version: 0 };
  rows.rows.set('currentMessage', ConversationPointers.parse(both));
  assert.equal(await currentMessageId(rows, '1'), op);
  assert.equal(await currentMessageId(rows, '2'), run);
});

// Captured 2026-11-16: the Catalog's rows for sessions made before list rows existed, as `indexSession` stored them,
// the creation under its lookup key and again under its creation-ordered list key. The first is from before versions,
// the second from the current code. Do not edit.
const INDEXED = {
  [`id:${sessionId}`]: V0.plainCreation,
  [`session:2026-11-10T09:30:00.000Z:${sessionId}`]: V0.plainCreation,
  'id:7d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f': {
    request: { operationId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' },
    template: 'cloud-swe',
    model: { provider: 'anthropic', id: 'claude-sonnet-5-5' },
    sessionId: '7d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
    workspaceId: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
    createdAt: '2026-11-15T18:00:00.000Z',
    version: 1,
  },
  'session:2026-11-15T18:00:00.000Z:7d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f': {
    request: { operationId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' },
    template: 'cloud-swe',
    model: { provider: 'anthropic', id: 'claude-sonnet-5-5' },
    sessionId: '7d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
    workspaceId: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
    createdAt: '2026-11-15T18:00:00.000Z',
    version: 1,
  },
};

test('sessions indexed before list rows are listed once the Catalog starts, without their old list keys', async () => {
  const rows = memoryStorage(new Map(Object.entries(INDEXED)));
  // SAFETY: the fake answers every storage call these functions make.
  const catalog = rows as never;
  const later = '7d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

  await fillSummaries(catalog);
  const { sessions, next } = await listSummaries(catalog, undefined, 10);

  // What the Catalog alone can say about them; each session writes its real row the next time it starts.
  const derived = { title: null, preview: null, run: { kind: 'idle' }, openRequests: 0, activeConversationId: '1' };

  assert.deepEqual(sessions, [
    { id: later, ...derived, createdAt: '2026-11-15T18:00:00.000Z', updatedAt: '2026-11-15T18:00:00.000Z' },
    { id: sessionId, ...derived, createdAt: V0.plainCreation.createdAt, updatedAt: V0.plainCreation.createdAt },
  ]);
  assert.equal(next, undefined);
  assert.deepEqual(
    [...rows.rows.keys()].filter((key) => key.startsWith('session:')),
    [],
  );
  assert.ok(await readSessionCreation(rows, later), 'the lookup row stays: a replacement sandbox reads its template');

  // A row the session already wrote is kept; running again finds nothing to do.
  await writeSummary(
    catalog,
    StoredSessionSummary.parse({
      ...derived,
      sessionId,
      title: 'Named',
      createdAt: V0.plainCreation.createdAt,
      updatedAt: '2026-11-16T00:00:00.000Z',
    }),
  );
  rows.rows.set(`session:2026-11-10T09:30:00.000Z:${sessionId}`, V0.plainCreation);
  await fillSummaries(catalog);
  assert.equal((await listSummaries(catalog, undefined, 10)).sessions[0]?.title, 'Named');
});

// Captured 2026-11-17: requests as the code before `afterEntry` stored them, with the version every write stores. Do not
// edit.
const REQUESTS_V0 = {
  question: {
    question: {
      id: '99999999-9999-4999-8999-999999999999',
      questions: [
        {
          question: 'Ship it?',
          header: 'Ship',
          options: [
            { label: 'Yes', description: 'Now' },
            { label: 'No', description: 'Later' },
          ],
          multiSelect: false,
        },
      ],
      createdAt: '2026-11-17T08:00:00.000Z',
      state: 'declined',
      decidedAt: '2026-11-17T08:05:00.000Z',
    },
    delivered: true,
    version: 0,
  },
  secretRequest: {
    request: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      environment: 'dev',
      name: 'OPENAI_API_KEY',
      hosts: ['api.openai.com'],
      header: 'Authorization',
      reason: 'To call the model in tests',
      state: 'declined',
      createdAt: '2026-11-17T08:00:00.000Z',
      decidedAt: '2026-11-17T08:05:00.000Z',
    },
    delivered: false,
    version: 0,
  },
};

test('requests stored before afterEntry, versioned or not, read as filed before every entry', async () => {
  const rows = storage();
  const read = async (key: string, schema: z.ZodType) => readParsed(rows, key, schema);

  const kinds = [
    ['question:', StoredQuestion, V0.questions.map((row) => [row.question.id, row] as const)],
    ['secretRequest:', StoredSecretRequest, V0.secretRequests.map((row) => [row.request.id, row] as const)],
  ] as const;

  for (const [prefix, schema, unversioned] of kinds) {
    for (const [id, row] of unversioned) {
      assert.deepEqual(await read(prefix + id, schema), { ...row, afterEntry: 0, version: 1 }, prefix + id);
    }
  }

  const current = [
    ['question:' + REQUESTS_V0.question.question.id, StoredQuestion, REQUESTS_V0.question],
    ['secretRequest:' + REQUESTS_V0.secretRequest.request.id, StoredSecretRequest, REQUESTS_V0.secretRequest],
  ] as const;

  for (const [key, schema, row] of current) {
    rows.rows.set(key, row);
    assert.deepEqual(await read(key, schema), { ...row, afterEntry: 0, version: 1 }, key);

    // A version-1 row is read as it is, and its afterEntry never reaches a client.
    rows.rows.set(key, { ...row, afterEntry: 12, version: 1 });
    assert.deepEqual(await read(key, schema), { ...row, afterEntry: 12, version: 1 }, key);
  }

  assert.deepEqual((await questionProjection(rows)).at(-1), REQUESTS_V0.question.question);
  assert.deepEqual((await secretRequestProjection(rows)).at(-1), REQUESTS_V0.secretRequest.request);
});
