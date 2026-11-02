/**
 * Path: server/test/workspace-backends.test.ts
 * Used by: pnpm test.
 * Purpose: Boat and Docker response schemas, and how Boat and E2B responses map to tool and lifecycle results.
 */

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { SessionCreation, WorkspaceRecord } from '@cloud-swe/protocol/storage';
import { FileError } from '@earendil-works/pi-durable/env';
import {
  AuthenticationError,
  FileNotFoundError,
  InvalidArgumentError,
  Sandbox,
  SandboxError,
  SandboxNotFoundError,
} from 'e2b';
import { Effect } from 'effect';

import { readRemoteFile, remoteFileInfo, writeRemoteFile } from '../src/sandbox/remote.ts';
import { BoatApiError, BoatSandboxCreated, BoatSandboxList } from '../src/workspaces/boat.ts';
import { DockerWorkspaceInfo } from '../src/workspaces/docker.ts';
import { inspectWorkspace, provisionWorkspace, recoverOrProvisionWorkspace } from '../src/workspaces/index.ts';

const id = 'fa879d6e-bd71-48df-a621-f070c8df45da';

test('sandbox identities are validated per backend', () => {
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

test('Boat error envelopes require a code', () => {
  assert.equal(
    BoatApiError.parse({ ok: false, error: { code: 'idempotency_in_progress', message: 'Creating' } }).error.code,
    'idempotency_in_progress',
  );

  for (const raw of [
    {},
    { ok: false, error: { code: 409 } },
    { ok: true, error: { code: 'idempotency_in_progress' } },
  ]) {
    assert.equal(BoatApiError.safeParse(raw).success, false);
  }
});

const workspace = WorkspaceRecord.parse({
  id: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  provider: 'boat',
  sandboxId: 'bx_23456789',
});

const env = { BOAT_API_KEY: 'boat_test_transport_only' };

const boatError = (status: number, code: string, message: string) =>
  Response.json(
    { ok: false, type: 'sandbox.error', status, code, message, error: { code, message, status } },
    { status },
  );

test('Boat errors map to file errors using its real responses and never expose upstream bodies', async (t) => {
  let response = () => boatError(400, 'sandbox_direct_failed', "ENOENT: no such file or directory, stat '/tmp/a'");
  t.mock.method(globalThis, 'fetch', async () => response());
  const signal = AbortSignal.timeout(5000);

  await assert.rejects(readRemoteFile(env, workspace, 'missing.txt', signal), { code: 'not_found' });

  response = () => boatError(400, 'sandbox_direct_failed', 'No such file or directory: /tmp/a');
  await assert.rejects(remoteFileInfo(env, workspace, 'missing.txt', signal), { code: 'not_found' });

  response = () => boatError(404, 'not_found', 'not_found');
  await assert.rejects(readRemoteFile(env, workspace, 'gone.txt', signal), { code: 'not_found' });

  response = () => boatError(400, 'invalid_path', 'Path must resolve under /home/user or /tmp');
  await assert.rejects(readRemoteFile(env, workspace, '/etc/hostname', signal), { code: 'invalid' });

  response = () => boatError(400, 'sandbox_direct_failed', 'Path is not a file.');
  await assert.rejects(readRemoteFile(env, workspace, '/tmp', signal), { code: 'invalid' });

  response = () => boatError(500, 'internal', 'secret upstream detail');
  await assert.rejects(
    readRemoteFile(env, workspace, 'missing.txt', signal),
    (error) => error instanceof FileError && error.code === 'unknown' && !error.message.includes('secret'),
  );
});

const e2bEnv = { E2B_API_KEY: 'e2b_test_transport_only', WORKSPACE_BACKEND: 'e2b' } as const;
const e2bWorkspace = WorkspaceRecord.parse({ ...workspace, provider: 'e2b', sandboxId: 'sandbox-1' });

const creation = SessionCreation.parse({
  request: { operationId: id, environment: 'cloud-swe', model: { provider: 'anthropic', id: 'configured-model' } },
  sessionId: id,
  workspaceId: id,
  createdAt: new Date().toISOString(),
});

const run = <Value, Failure>(effect: Effect.Effect<Value, Failure>) => Effect.runPromise(effect);

// The SDK keeps the fetch it loaded with, so these replace its entry points. E2B's real statuses are in e2b-live.test.ts.
function connectTo(t: TestContext, files: Record<string, (...args: never[]) => Promise<object | void>>) {
  t.mock.method(Sandbox, 'connect', async () => ({ files }));
}

const apiError = (status: number) =>
  Object.assign(new SandboxError(`${status}: secret upstream detail`), { statusCode: status });

test('E2B errors map to file errors and never expose upstream bodies', async (t) => {
  let failure: Error = new FileNotFoundError('path does not exist');

  connectTo(t, {
    read: async () => {
      throw failure;
    },
  });
  const signal = AbortSignal.timeout(5000);

  await assert.rejects(readRemoteFile(e2bEnv, e2bWorkspace, '/gone', signal), { code: 'not_found' });

  failure = new InvalidArgumentError('path is a directory');
  await assert.rejects(readRemoteFile(e2bEnv, e2bWorkspace, '/tmp', signal), { code: 'invalid' });

  failure = apiError(500);
  await assert.rejects(
    readRemoteFile(e2bEnv, e2bWorkspace, '/x', signal),
    (error) => error instanceof FileError && error.code === 'unknown' && !error.message.includes('secret'),
  );
});

test('an E2B sandbox that is gone reads as not_found, which cancellation treats as stopped', async (t) => {
  t.mock.method(Sandbox, 'connect', async () => {
    throw new SandboxNotFoundError('Paused sandbox not found');
  });

  await assert.rejects(readRemoteFile(e2bEnv, e2bWorkspace, '/x', AbortSignal.timeout(5000)), { code: 'not_found' });
});

test('E2B reads are bounded by size', async (t) => {
  connectTo(t, {
    read: async () => new Blob([new Uint8Array(5_242_881)]).stream(),
  });

  await assert.rejects(readRemoteFile(e2bEnv, e2bWorkspace, '/big', AbortSignal.timeout(5000)), { code: 'unknown' });
});

test("a denied E2B overwrite is written in place as the file's owner, and only then", async (t) => {
  const signal = AbortSignal.timeout(5000);
  const calls: string[] = [];
  let denied = true;

  connectTo(t, {
    write: async (_path: string, _content: string, opts: { user?: string }) => {
      calls.push(`write as ${opts.user ?? 'default'}`);

      if (denied) {
        denied = false;
        throw new SandboxError('500: error opening file: open /tmp/a: permission denied');
      }
    },
    getInfo: async () => ({ owner: 'user' }),
  });

  await writeRemoteFile(e2bEnv, e2bWorkspace, '/tmp/a', 'text', signal);
  assert.deepEqual(calls, ['write as default', 'write as user'], 'nothing is removed');

  calls.length = 0;
  await writeRemoteFile(e2bEnv, e2bWorkspace, '/tmp/a', 'text', signal);
  assert.deepEqual(calls, ['write as default'], 'a successful write takes one request');
});

test('E2B states map to workspace states', async (t) => {
  let state: string | Error = 'paused';

  t.mock.method(Sandbox, 'getInfo', async () => {
    if (state instanceof Error) throw state;

    return { state };
  });

  assert.equal(await run(inspectWorkspace(e2bEnv, 'sandbox-1')), 'stopped');

  state = 'running';
  assert.equal(await run(inspectWorkspace(e2bEnv, 'sandbox-1')), 'running');

  state = 'something-new';
  await assert.rejects(run(inspectWorkspace(e2bEnv, 'sandbox-1')), { reason: 'invalid_response' });

  state = new SandboxNotFoundError('Sandbox not found');
  assert.equal(await run(inspectWorkspace(e2bEnv, 'sandbox-1')), 'deleted');

  state = apiError(500);
  await assert.rejects(run(inspectWorkspace(e2bEnv, 'sandbox-1')), { reason: 'unavailable' });
});

test('an E2B create is refused only when E2B said so, because anything else may have made a sandbox', async (t) => {
  let failure: Error = apiError(404);

  t.mock.method(Sandbox, 'create', async () => {
    throw failure;
  });

  await assert.rejects(run(provisionWorkspace(e2bEnv, creation)), { reason: 'refused' });

  failure = new AuthenticationError('bad key');
  await assert.rejects(run(provisionWorkspace(e2bEnv, creation)), { reason: 'refused' });

  failure = apiError(500);
  await assert.rejects(run(provisionWorkspace(e2bEnv, creation)), { reason: 'unavailable' });

  failure = new Error('connection dropped');
  await assert.rejects(run(provisionWorkspace(e2bEnv, creation)), { reason: 'unavailable' });

  await assert.rejects(run(provisionWorkspace({ WORKSPACE_BACKEND: 'e2b' }, creation)), { reason: 'configuration' });
});

test('E2B recovery never guesses between sandboxes, or treats a failed lookup as absence', async (t) => {
  let found: { sandboxId: string }[] | Error = [{ sandboxId: 'sandbox-1' }];
  let hasNext = false;
  let creates = 0;

  t.mock.method(Sandbox, 'list', () => ({
    hasNext,
    nextItems: async () => {
      if (found instanceof Error) throw found;

      return found;
    },
  }));

  t.mock.method(Sandbox, 'create', async () => {
    creates++;

    return { sandboxId: 'sandbox-new' };
  });

  assert.equal(await run(recoverOrProvisionWorkspace(e2bEnv, creation)), 'sandbox-1');

  found = [{ sandboxId: 'sandbox-1' }, { sandboxId: 'sandbox-2' }];
  await assert.rejects(run(recoverOrProvisionWorkspace(e2bEnv, creation)), { reason: 'uncertain' });

  found = [{ sandboxId: 'sandbox-1' }];
  hasNext = true;
  await assert.rejects(run(recoverOrProvisionWorkspace(e2bEnv, creation)), { reason: 'uncertain' });

  found = apiError(500);
  await assert.rejects(run(recoverOrProvisionWorkspace(e2bEnv, creation)), { reason: 'unavailable' });
  assert.equal(creates, 0, 'nothing was created while the lookup was unsure');

  found = [];
  hasNext = false;
  assert.equal(await run(recoverOrProvisionWorkspace(e2bEnv, creation)), 'sandbox-new');
  assert.equal(creates, 1);
});
