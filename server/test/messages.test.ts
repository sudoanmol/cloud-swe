/**
 * Path: server/test/messages.test.ts
 * Used by: pnpm test.
 * Purpose: Durable message admission, retries, run state and sanitized provider failure over HTTP.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { ApiError, CreateSessionResponse, OperationReceipt, Session } from '@cloud-swe/protocol';
import { Response as WorkerResponse } from 'miniflare';

import { modelAnswer } from './model-answer.ts';
import { runtime } from './runtime.ts';

const token = 'integration-test-personal-token';
const model = { provider: 'anthropic', id: 'claude-sonnet-5-5' };
const secret = 'test-model-key-never-persist';

test(
  'durable HTTP message admission, retries, run state and sanitized provider failure',
  { timeout: 30_000 },
  async () => {
    const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-messages-'));
    const bindings = { WORKSPACE_BACKEND: 'docker', MODEL_ID: model.id, ANTHROPIC_API_KEY: secret };
    let calls = 0;
    let release: (() => void) | undefined;
    let failProvider = false;

    const dev = {
      outboundService: {
        type: 'fetcher',
        handler: async (request) => {
          if (new URL(request.url).hostname !== 'api.anthropic.com') {
            assert.equal(new URL(request.url).hostname, 'sandbox');
            const response = await fetch(request.url, { method: request.method, headers: [...request.headers] });

            return new WorkerResponse(await response.arrayBuffer(), {
              status: response.status,
              headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'application/json' },
            });
          }

          calls++;
          assert.equal(request.headers.get('x-api-key'), secret);
          assert.equal(new URL(request.url).pathname, '/v1/messages');

          if (failProvider)
            return WorkerResponse.json(
              { type: 'error', error: { type: 'authentication_error', message: secret } },
              { status: 401 },
            );

          await new Promise<void>((resolve) => {
            release = resolve;
          });

          return modelAnswer(model.id);
        },
      },
    } satisfies NonNullable<Parameters<typeof runtime>[2]>;

    let mf = runtime(storage, bindings, dev);
    let base = await mf.ready;

    const request = (path: string, init: RequestInit = {}) =>
      fetch(new URL(path, base), {
        ...init,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
      });

    try {
      const created = await request('/v1/sessions', {
        method: 'POST',
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          template: 'base',
          model,
        }),
      });

      assert.equal(created.status, 201, await created.clone().text());
      const { session } = CreateSessionResponse.parse(await created.json());
      const path = `/v1/sessions/${session.id}`;
      const getSession = async () => Session.parse(await (await request(path)).json());

      const submit = (body: Record<string, string>) =>
        request(path + '/messages', { method: 'POST', body: JSON.stringify(body) });

      const input = { operationId: crypto.randomUUID(), text: 'Say hello' };

      async function settled() {
        for (let attempt = 0; attempt < 200; attempt++) {
          const current = await getSession();

          if (current.run.kind !== 'running') return current;
          await setTimeout(10);
        }

        throw new Error('Run did not settle');
      }

      assert.equal(session.capabilities.submitMessage, true);
      assert.equal((await submit({ ...input, text: '  ' })).status, 400);
      assert.equal((await submit({ ...input, token: secret })).status, 400);
      assert.equal(
        (await request(`/v1/sessions/${crypto.randomUUID()}/messages`, { method: 'POST', body: '{}' })).status,
        404,
      );
      assert.equal((await fetch(new URL(path + '/messages', base), { method: 'POST', body: '{}' })).status, 401);

      const responses = await Promise.all([submit(input), submit(input), submit(input)]);
      const receipts = [];

      for (const response of responses) {
        assert.equal(response.status, 202, await response.clone().text());
        receipts.push(OperationReceipt.parse(await response.json()));
      }

      const receipt = receipts[0];
      assert.ok(receipt);
      assert.deepEqual(receipts, [receipt, receipt, receipt]);
      const active = await getSession();
      assert.deepEqual(active.run, { kind: 'running', runId: receipt.runId });
      assert.deepEqual(
        OperationReceipt.parse(await (await request(path + `/operations/${input.operationId}`)).json()),
        receipt,
      );
      const changed = await submit({ ...input, text: 'different intent' });
      assert.equal(changed.status, 409);
      assert.equal(ApiError.parse(await changed.json()).error.code, 'operation_conflict');
      const busy = await submit({ ...input, operationId: crypto.randomUUID() });
      assert.equal(busy.status, 409);
      assert.equal(ApiError.parse(await busy.json()).error.code, 'session_busy');
      assert.equal((await request(path + `/operations/${crypto.randomUUID()}`)).status, 404);
      assert.equal((await request(path + '/operations/not-an-id')).status, 400);

      for (let attempt = 0; !release && attempt < 200; attempt++) await setTimeout(10);
      assert.ok(release, 'model transport was intercepted');
      release();
      const completed = await settled();
      assert.deepEqual(completed.run, { kind: 'completed', runId: receipt.runId });
      assert.equal(session.updatedAt, session.createdAt);
      assert.ok(Date.parse(completed.updatedAt) > Date.parse(session.createdAt), 'activity moves updatedAt');
      assert.equal(calls, 1, 'same-ID retries admit one native input');

      const database = await mf.unsafeGetDurableObjectStorage('cloud-swe-server', 'SessionThreadV2', {
        name: session.id,
      });

      assert.equal((await database.exec('SELECT * FROM pi_submissions')).length, 1);

      await mf.dispose();
      mf = runtime(storage, { ...bindings, ANTHROPIC_API_KEY: '' }, dev);
      base = await mf.ready;
      assert.deepEqual((await getSession()).run, { kind: 'completed', runId: receipt.runId });
      assert.equal((await getSession()).capabilities.submitMessage, false);
      const replay = await submit(input);
      assert.equal(replay.status, 202, 'existing receipts survive credential removal and restart');
      assert.deepEqual(OperationReceipt.parse(await replay.json()), receipt);
      const noKey = { ...input, operationId: crypto.randomUUID() };
      assert.equal((await submit(noKey)).status, 503);
      assert.equal(
        (await request(path + `/operations/${noKey.operationId}`)).status,
        404,
        'missing auth reserves no admission',
      );
      assert.equal(calls, 1);

      await mf.dispose();
      mf = runtime(storage, bindings, dev);
      base = await mf.ready;
      failProvider = true;
      assert.equal((await submit(noKey)).status, 202);
      const failed = await settled();
      assert.equal(failed.run.kind, 'failed');

      const persisted = await mf.unsafeGetDurableObjectStorage('cloud-swe-server', 'SessionThreadV2', {
        name: session.id,
      });

      for (const table of ['pi_entries', 'pi_tasks', 'pi_submissions', 'pi_documents']) {
        assert.equal(
          JSON.stringify(await persisted.exec(`SELECT * FROM ${table}`)).includes(secret),
          false,
          table + ' must not contain provider secrets',
        );
      }

      assert.equal(JSON.stringify(failed).includes(secret), false);
      assert.equal(calls, 2);
    } finally {
      release?.();
      await mf.dispose();
      await rm(storage, { recursive: true, force: true });
    }
  },
);
