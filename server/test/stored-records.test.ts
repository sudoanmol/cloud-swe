/**
 * Path: server/test/stored-records.test.ts
 * Used by: pnpm test.
 * Purpose: Rows exactly as production stores them today (version 0, captured from the schemas before stored records got their own) read through the current code and project to the public shapes clients get.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CancelRunResponse, OperationReceipt } from '@cloud-swe/protocol';
import { pullRequestView, repoView, sessionView } from '@cloud-swe/protocol/storage';

import { readAccess } from '../src/git/access.ts';
import { approvalProjection } from '../src/git/approvals.ts';
import { listPulls } from '../src/git/pull-store.ts';
import { readRepos } from '../src/git/repos.ts';
import { readCreation, readSessionCreation, readWorkspace } from '../src/sessions/catalog-store.ts';
import { readCancellation, readMessage, readSession } from '../src/thread-store.ts';
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
  approvals: [
    {
      approval: {
        id: '11111111-1111-4111-8111-111111111111',
        repo: 'https://github.com/octo/hello',
        state: 'pending',
        createdAt: '2026-11-10T09:30:00.000Z',
        kind: 'ref_update',
        sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        targetBranch: 'main',
        force: false,
        expected: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      delivered: false,
    },
    {
      approval: {
        id: '22222222-2222-4222-8222-222222222222',
        repo: 'https://github.com/octo/hello',
        state: 'succeeded',
        result: 'Merged',
        createdAt: '2026-11-10T09:30:00.000Z',
        decidedAt: '2026-11-10T09:30:00.000Z',
        kind: 'pr_merge',
        number: 7,
        method: 'squash',
        expected: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        baseRef: 'main',
      },
      delivered: true,
    },
    {
      approval: {
        id: '33333333-3333-4333-8333-333333333333',
        repo: 'https://github.com/octo/hello',
        state: 'rejected',
        result: 'Rejected by the user',
        createdAt: '2026-11-10T09:30:00.000Z',
        decidedAt: '2026-11-10T09:30:00.000Z',
        kind: 'ref_change',
        ref: 'refs/tags/v1',
        sha: null,
        expected: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      delivered: false,
    },
  ],
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
  pull: {
    repo: 'https://github.com/octo/hello',
    number: 7,
    title: 'Fix the test',
    url: 'https://github.com/octo/hello/pull/7',
    state: 'open',
    head: 'cloud-swe/fix-6f1c2b8e',
    base: 'main',
  },
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
      ...V0.approvals.map((row): [string, unknown] => [`approval:${row.approval.id}`, row]),
      ...V0.questions.map((row): [string, unknown] => [`question:${row.question.id}`, row]),
      ...V0.secretRequests.map((row): [string, unknown] => [`secretRequest:${row.request.id}`, row]),
      ['repos', V0.repos],
      ['pull:https://github.com/octo/hello#0000000007', V0.pull],
      ['gitAccess', V0.gitAccess],
    ]),
  );
}

test('version-0 Thread and Catalog rows read through the current code', async () => {
  const rows = storage();

  assert.deepEqual(await readSession(rows), {
    id: sessionId,
    runtime: V0.session.runtime,
    model: V0.session.model,
    workspace: { id: V0.session.workspace.id, provider: 'e2b' },
    environment: 'dev',
    createdAt: V0.session.createdAt,
    version: 0,
  });

  assert.deepEqual(await readCreation(rows, op), { ...V0.creation, version: 0 });
  assert.deepEqual(await readSessionCreation(rows, sessionId), { ...V0.plainCreation, version: 0 });
  assert.deepEqual(await readWorkspace(rows, V0.workspace.id), { ...V0.workspace, version: 0 });
  assert.deepEqual(await readAccess(rows), { ...V0.gitAccess, version: 0 });

  const message = await readMessage(rows, op);
  assert.deepEqual(message, { ...V0.message, version: 0 });
  assert.deepEqual(OperationReceipt.parse(message?.receipt), V0.message.receipt);
  assert.deepEqual(await readMessage(rows, run), { ...V0.followUp, version: 0 });

  const cancel = await readCancellation(rows, run);
  assert.deepEqual(cancel, { ...V0.cancel, version: 0 });
  assert.deepEqual(CancelRunResponse.parse(cancel?.receipt), V0.cancel.receipt);
});

test('version-0 rows project to the public shapes clients get', async () => {
  const rows = storage();

  assert.deepEqual(
    await approvalProjection(rows),
    V0.approvals.map((row) => row.approval),
  );

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
  assert.deepEqual((await listPulls(rows)).map(pullRequestView), [V0.pull]);

  const stored = await readSession(rows);
  assert.ok(stored);

  const workspaceState = 'stopped';

  const {
    id: _id,
    runtime: _runtime,
    workspace,
    environment: _environment,
    createdAt: _createdAt,
    ...live
  } = V0.session;

  assert.deepEqual(sessionView(stored, { ...live, run: { kind: 'idle' }, workspaceState }), {
    ...V0.session,
    workspace: { ...workspace, state: workspaceState },
  });
});
