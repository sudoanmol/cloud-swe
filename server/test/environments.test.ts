/**
 * Path: server/test/environments.test.ts
 * Used by: pnpm test.
 * Purpose: The /v1/environments routes and session binding: CRUD, limits, conflicts, invalid values and hosts, and that no response ever carries a network value or placeholder.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ApiError, CreateSessionResponse } from '@cloud-swe/protocol';
import { EnvironmentView, ListEnvironmentsResponse } from '@cloud-swe/protocol/environments';

import { runtime } from './runtime.ts';

const token = 'integration-test-personal-token';
const SECRET = 'sk-network-value-never-returned';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

test('environments: CRUD, limits and write-only network secrets', { timeout: 90_000 }, async (t) => {
  const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-env-'));
  const mf = runtime(storage, { PUBLIC_URL: 'https://cloud-swe.example.com' });
  // Every response body this test sees, checked at the end for the network value and any placeholder.
  const seen: string[] = [];

  try {
    const base = await mf.ready;

    const api = async (path: string, method = 'GET', body?: Json) => {
      const init: RequestInit = {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      };

      if (body !== undefined) init.body = JSON.stringify(body);
      const response = await fetch(new URL(path, base), init);

      const text = await response.text();
      seen.push(text);

      return { status: response.status, headers: response.headers, json: () => JSON.parse(text) };
    };

    const code = async (response: Awaited<ReturnType<typeof api>>) => ApiError.parse(response.json()).error.code;

    await t.test('signed-in only, and never cached', async () => {
      assert.equal((await fetch(new URL('/v1/environments', base))).status, 401);
      const list = await api('/v1/environments');
      assert.equal(list.status, 200);
      assert.equal(list.headers.get('cache-control'), 'no-store');
      assert.deepEqual(ListEnvironmentsResponse.parse(list.json()).environments, []);
      const missing = await api('/v1/environments/nope/variables/A', 'PUT', { value: 'x' });
      assert.equal(await code(missing), 'environment_not_found');
      assert.equal(missing.headers.get('cache-control'), 'no-store');
    });

    await t.test('round trip', async () => {
      assert.equal((await api('/v1/environments/dev', 'PUT', {})).status, 200);
      // Idempotent.
      assert.equal(EnvironmentView.parse((await api('/v1/environments/dev', 'PUT', {})).json()).name, 'dev');

      const variable = await api('/v1/environments/dev/variables/DATABASE_URL', 'PUT', { value: 'postgres://dev' });
      assert.deepEqual(EnvironmentView.parse(variable.json()).variables.DATABASE_URL?.updatedBy, { kind: 'client' });

      const secret = await api('/v1/environments/dev/network-secrets/OPENAI_API_KEY', 'PUT', {
        value: SECRET,
        hosts: ['api.openai.com'],
      });

      const view = EnvironmentView.parse(secret.json());
      assert.deepEqual(view.networkSecrets.OPENAI_API_KEY?.hosts, ['api.openai.com']);
      assert.equal(view.networkSecrets.OPENAI_API_KEY?.header, 'Authorization');

      await api('/v1/environments/dev/network-secrets/OPENAI_API_KEY', 'PUT', {
        value: SECRET + '-2',
        hosts: ['api.openai.com', 'api.other.example'],
        header: 'x-api-key',
      });

      const [listed] = ListEnvironmentsResponse.parse((await api('/v1/environments')).json()).environments;
      assert.equal(listed?.variables.DATABASE_URL?.value, 'postgres://dev');
      assert.equal(listed?.networkSecrets.OPENAI_API_KEY?.header, 'x-api-key');

      const deleted = await api('/v1/environments/dev/variables/DATABASE_URL', 'DELETE');
      assert.deepEqual(EnvironmentView.parse(deleted.json()).variables, {});
      const gone = await api('/v1/environments/dev/network-secrets/OPENAI_API_KEY', 'DELETE');
      assert.deepEqual(EnvironmentView.parse(gone.json()).networkSecrets, {});

      assert.equal((await api('/v1/environments/dev', 'DELETE')).status, 204);
      assert.equal(await code(await api('/v1/environments/dev', 'DELETE')), 'environment_not_found');
    });

    await t.test('invalid names, values and hosts change nothing', async () => {
      await api('/v1/environments/dev', 'PUT', {});

      for (const [path, body] of [
        ['/v1/environments/Dev', {}],
        ['/v1/environments/dev', { extra: 1 }],
        ['/v1/environments/dev/variables/PATH', { value: 'x' }],
        ['/v1/environments/dev/variables/OK', { value: 'a\0b' }],
        ['/v1/environments/dev/network-secrets/KEY', { value: 'a\nb', hosts: ['api.openai.com'] }],
        ['/v1/environments/dev/network-secrets/KEY', { value: 'a\rb', hosts: ['api.openai.com'] }],
        ['/v1/environments/dev/network-secrets/KEY', { value: 'a\0b', hosts: ['api.openai.com'] }],
      ] satisfies [string, Json][]) {
        assert.equal(await code(await api(path, 'PUT', body)), 'invalid_request', path);
      }

      for (const host of ['github.com', 'registry.npmjs.org', '127.0.0.1', 'cloud-swe.example.com']) {
        const response = await api('/v1/environments/dev/network-secrets/KEY', 'PUT', { value: 'v', hosts: [host] });
        assert.equal(await code(response), 'invalid_host', host);
      }

      const [dev] = ListEnvironmentsResponse.parse((await api('/v1/environments')).json()).environments;
      assert.deepEqual(dev?.variables, {});
      assert.deepEqual(dev?.networkSecrets, {});
    });

    await t.test('a name is a variable or a network secret, not both', async () => {
      await api('/v1/environments/dev/variables/SHARED', 'PUT', { value: 'x' });

      const secret = await api('/v1/environments/dev/network-secrets/SHARED', 'PUT', {
        value: 'v',
        hosts: ['api.openai.com'],
      });

      assert.equal(await code(secret), 'secret_name_conflict');

      await api('/v1/environments/dev/network-secrets/TOKEN', 'PUT', { value: SECRET, hosts: ['api.openai.com'] });
      assert.equal(
        await code(await api('/v1/environments/dev/variables/TOKEN', 'PUT', { value: 'x' })),
        'secret_name_conflict',
      );
    });

    await t.test('limits', async () => {
      for (let index = 0; index < 50; index++) {
        const name = `V${index}`;
        const response = await api(`/v1/environments/dev/variables/${name}`, 'PUT', { value: 'x' });

        // SHARED already holds one slot.
        if (index < 49) assert.equal(response.status, 200, name);
        else assert.equal(await code(response), 'environment_limit');
      }

      // Updating an existing variable at the limit still works.
      assert.equal((await api('/v1/environments/dev/variables/V0', 'PUT', { value: 'y' })).status, 200);

      for (let index = 0; index < 20; index++) {
        const response = await api(`/v1/environments/dev/network-secrets/N${index}`, 'PUT', {
          value: SECRET,
          hosts: ['api.openai.com'],
        });

        // TOKEN already holds one slot.
        if (index < 19) assert.equal(response.status, 200);
        else assert.equal(await code(response), 'environment_limit');
      }

      for (let index = 1; index < 20; index++) {
        assert.equal((await api(`/v1/environments/e${index}`, 'PUT', {})).status, 200);
      }

      assert.equal(await code(await api('/v1/environments/e20', 'PUT', {})), 'environment_limit');
      await api('/v1/environments/e19', 'DELETE');
    });

    await t.test('a session binds an existing environment, and only at creation', async () => {
      const request = { template: 'base', model: { provider: 'anthropic', id: 'configured-model' } };

      const unknown = await api('/v1/sessions', 'POST', {
        ...request,
        operationId: crypto.randomUUID(),
        environment: 'missing',
      });

      assert.equal(await code(unknown), 'unknown_environment');

      const plain = await api('/v1/sessions', 'POST', { ...request, operationId: crypto.randomUUID() });
      assert.equal(CreateSessionResponse.parse(plain.json()).session.environment, null);

      await api('/v1/environments/staging', 'PUT', {});
      const operationId = crypto.randomUUID();
      const bound = await api('/v1/sessions', 'POST', { ...request, operationId, environment: 'staging' });
      assert.equal(bound.status, 201);
      const { session } = CreateSessionResponse.parse(bound.json());
      assert.equal(session.environment, 'staging');

      // A retry after the environment is deleted returns the same session; reads project it.
      await api('/v1/environments/staging', 'DELETE');
      const retry = await api('/v1/sessions', 'POST', { ...request, operationId, environment: 'staging' });
      assert.equal(retry.status, 200);
      assert.equal((await api(`/v1/sessions/${session.id}`)).json().environment, 'staging');
    });

    await t.test('no response ever carried a network value or placeholder', () => {
      for (const body of seen) {
        assert.equal(body.includes(SECRET), false);
        assert.equal(body.includes('cloudswe_ph_'), false);
      }
    });
  } finally {
    await mf.dispose();
    await rm(storage, { recursive: true, force: true });
  }
});
