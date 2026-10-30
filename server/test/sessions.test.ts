import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BoatApi, Configuration } from '@boatdev/sdk';
import {
  ApiError,
  CreateSessionRequest,
  CreateSessionResponse,
  ListSessionsResponse,
  Session,
} from '@cloud-swe/protocol';

import { runtime } from './runtime.ts';

const environment = 'base';
const token = 'integration-test-personal-token';
const model = { provider: 'anthropic', id: 'configured-model' };
const backend = process.env.WORKSPACE_BACKEND ?? 'docker';

if (backend !== 'docker' && backend !== 'boat') throw new Error('Invalid WORKSPACE_BACKEND');

if (backend === 'boat' && !process.env.BOAT_API_KEY) throw new Error('Boat mode requires BOAT_API_KEY');

const boat = () => new BoatApi(new Configuration({ accessToken: process.env.BOAT_API_KEY, fetchApi: fetch }));

/** The backend's own sandboxes for an app workspace, found the way the server finds lost ones: by name. */
async function sandboxesFor(workspaceId: string): Promise<string[]> {
  if (backend === 'docker') {
    const response = await fetch(new URL(`/workspaces/${workspaceId}`, process.env.DOCKER_SANDBOX_URL), {
      headers: { Authorization: `Bearer ${process.env.DOCKER_SANDBOX_TOKEN}` },
    });

    return response.ok ? [workspaceId] : [];
  }

  const { sandboxes } = await boat().sandboxes({ namePrefix: `cloud-swe-${workspaceId}` });

  return sandboxes.map(({ id }) => id);
}

// Boat mode bills real sandboxes, so the suite deletes every one it provisioned.
async function deleteBoatSandboxes(workspaceIds: string[]) {
  for (const workspaceId of workspaceIds) {
    for (const sandboxId of await sandboxesFor(workspaceId)) {
      await boat().deleteSandbox({ sandboxId, xAsciiConfirmDelete: sandboxId });
    }
  }
}

test(
  'real Hono HTTP → catalog DO → PiHarness → SQLite session, with workspace adapter',
  { timeout: 90_000 },
  async (t) => {
    const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-'));
    let mf = runtime(storage);
    let base: URL;

    async function request(path: string, options: RequestInit = {}) {
      return fetch(new URL(path, base), {
        ...options,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers },
      });
    }

    const intent = CreateSessionRequest.parse({
      operationId: crypto.randomUUID(),
      engine: 'pi',
      target: 'cloud',
      environment,
      model,
    });

    const post = (body: string) => request('/v1/sessions', { method: 'POST', body });
    const create = (body: CreateSessionRequest) => post(JSON.stringify(body));
    let session: Session | undefined;
    const workspaceIds: string[] = [];

    try {
      base = await mf.ready;
      await t.test('authentication precedes parsing and applies to unknown routes', async () => {
        for (const path of ['/v1/sessions', '/not-a-route']) {
          const response = await fetch(new URL(path, base));
          assert.equal(response.status, 401);
          assert.equal(ApiError.parse(await response.json()).error.code, 'unauthorized');
        }

        const wrong = await request('/v1/sessions', { headers: { Authorization: 'Bearer wrong' } });
        assert.equal(wrong.status, 401);
      });

      await t.test('invalid requests do not create sessions', async () => {
        for (const value of [
          {},
          { ...intent, token: 'never-accepted' },
          { ...intent, model: { provider: 'other', id: 'other' } },
          { ...intent, environment: 'not-allowlisted' },
          { ...intent, workspaceId: crypto.randomUUID() },
        ]) {
          const response = await post(JSON.stringify(value));
          assert.equal(response.status, 400);
          ApiError.parse(await response.json());
        }

        assert.equal((await post('{')).status, 400);
        const oversized = await post('x'.repeat(128 * 1024 + 1));
        assert.equal(oversized.status, 413);
        assert.deepEqual(ListSessionsResponse.parse(await (await request('/v1/sessions')).json()).sessions, []);
      });

      await t.test(`creation checks the actual ${backend} workspace and opens a native Pi conversation`, async () => {
        const response = await create(intent);
        assert.equal(response.status, 201, await response.clone().text());
        const body = CreateSessionResponse.parse(await response.json());
        assert.equal(body.operationId, intent.operationId);
        session = body.session;
        assert.deepEqual(session.model, model);
        assert.deepEqual(session.runtime, { kind: 'pi-durable', conversationId: '1' });
        const database = await mf.unsafeGetDurableObjectStorage('cloud-swe-server', 'Thread', { name: session.id });
        assert.deepEqual(await database.exec('SELECT id FROM pi_conversations'), [{ id: 1 }]);
        assert.equal(session.workspace.provider, backend);
        assert.equal(session.workspace.state, 'running');
        workspaceIds.push(session.workspace.id);
        const sandboxes = await sandboxesFor(session.workspace.id);
        assert.equal(sandboxes.length, 1, 'exactly one sandbox was provisioned');

        if (backend === 'boat') {
          assert.ok(!JSON.stringify(session).includes(String(sandboxes[0])), 'Boat sandbox IDs stay server-side');
        }

        assert.equal(session.capabilities.submitMessage, false);
        assert.deepEqual(session.capabilities.tools, []);
        assert.deepEqual(Session.parse(await (await request(`/v1/sessions/${session.id}`)).json()), session);
      });

      await t.test('lost receipt and concurrent retries return one session; changed intent conflicts', async () => {
        assert.ok(session);
        const responses = await Promise.all([create(intent), create(intent), create(intent)]);

        for (const response of responses) {
          assert.equal(response.status, 200);
          assert.equal(CreateSessionResponse.parse(await response.json()).session.id, session.id);
        }

        const conflict = await create({ ...intent, model: { ...model, id: 'changed-intent' } });
        assert.equal(conflict.status, 409);
        assert.equal(ApiError.parse(await conflict.json()).error.code, 'operation_conflict');
        const simultaneous = CreateSessionRequest.parse({ ...intent, operationId: crypto.randomUUID() });
        const concurrent = await Promise.all([create(simultaneous), create(simultaneous)]);
        assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 201]);
        const bodies = await Promise.all(concurrent.map(async (r) => CreateSessionResponse.parse(await r.json())));
        assert.equal(bodies[0]?.session.id, bodies[1]?.session.id);
        assert.notEqual(bodies[0]?.session.id, session.id);
        const second = bodies[0]?.session.workspace.id;
        assert.ok(second);
        workspaceIds.push(second);
        assert.notEqual(second, session.workspace.id, 'each session gets its own sandbox');
        assert.equal(bodies[1]?.session.workspace.id, second);
        assert.equal((await sandboxesFor(session.workspace.id)).length, 1, 'retries never provision a second sandbox');
        assert.equal((await sandboxesFor(second)).length, 1);
      });

      await t.test('list pagination is scoped/validated; unknown IDs and routes are not found', async () => {
        const first = ListSessionsResponse.parse(await (await request('/v1/sessions?limit=1')).json());
        assert.equal(first.sessions.length, 1);
        assert.ok(first.nextCursor);

        const second = ListSessionsResponse.parse(
          await (await request(`/v1/sessions?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).json(),
        );

        assert.equal(second.sessions.length, 1);
        assert.notEqual(first.sessions[0]?.id, second.sessions[0]?.id);
        assert.equal(second.nextCursor, null);

        for (const suffix of ['?limit=101', '?cursor=bad', '?cursor=' + btoa('history:other-session')]) {
          assert.equal((await request('/v1/sessions' + suffix)).status, 400);
        }

        assert.equal((await request('/v1/sessions/not-a-uuid')).status, 400);
        assert.equal((await request(`/v1/sessions/${crypto.randomUUID()}`)).status, 404);
        assert.equal((await request('/v1/sessions/unimplemented/path')).status, 404);
      });

      await t.test('session, native configuration, and deduplication survive a workerd restart', async () => {
        assert.ok(session);
        await mf.dispose();
        mf = runtime(storage);
        base = await mf.ready;
        assert.deepEqual(Session.parse(await (await request(`/v1/sessions/${session.id}`)).json()), session);
        const retry = await create(intent);
        assert.equal(retry.status, 200);
        assert.equal(CreateSessionResponse.parse(await retry.json()).session.id, session.id);
        assert.equal(ListSessionsResponse.parse(await (await request('/v1/sessions')).json()).sessions.length, 2);
        const database = await mf.unsafeGetDurableObjectStorage('cloud-swe-server', 'Thread', { name: session.id });
        assert.deepEqual(await database.exec('SELECT id FROM pi_conversations'), [{ id: 1 }]);
        assert.equal((await sandboxesFor(session.workspace.id)).length, 1);
      });
    } finally {
      if (backend === 'boat') await deleteBoatSandboxes(workspaceIds);
      await mf.dispose();
      await rm(storage, { recursive: true, force: true });
    }
  },
);

test(
  'unavailable workspace fails closed without a session; missing auth configuration fails closed',
  { timeout: 30_000 },
  async () => {
    const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-unavailable-'));
    const mf = runtime(storage, { WORKSPACE_BACKEND: 'boat', BOAT_API_KEY: '' });

    try {
      const base = await mf.ready;

      const response = await fetch(new URL('/v1/sessions', base), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId: crypto.randomUUID(), engine: 'pi', target: 'cloud', environment, model }),
      });

      assert.equal(response.status, 503);
      assert.equal(ApiError.parse(await response.json()).error.code, 'unavailable');
      const list = await fetch(new URL('/v1/sessions', base), { headers: { Authorization: `Bearer ${token}` } });
      assert.deepEqual(ListSessionsResponse.parse(await list.json()).sessions, []);
    } finally {
      await mf.dispose();
    }

    const unconfigured = runtime(storage, { API_TOKEN: '' });

    try {
      const response = await fetch(new URL('/v1/sessions', await unconfigured.ready));
      assert.equal(response.status, 503);
    } finally {
      await unconfigured.dispose();
      await rm(storage, { recursive: true, force: true });
    }
  },
);
