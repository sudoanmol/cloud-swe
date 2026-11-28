/**
 * Path: server/test/session-list.test.ts
 * Used by: pnpm test.
 * Purpose: The session list follows each session's own changes (activity order, title, preview, run state, open requests) with no client connected and without asking any session; session routes go straight to the session, which answers 404 for an unknown ID without storing anything; sign-in and the body limit still guard every session route.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { ApiError, ListSessionsResponse, type SessionSummary } from '@cloud-swe/protocol';
import { type Response as WorkerResponse } from 'miniflare';
import { z } from 'zod';

import { lifecycleRig } from './lifecycle-rig.ts';
import { modelAnswer } from './model-answer.ts';
import { headers, model, threadDatabases, waitFor } from './rig.ts';
import { runtime } from './runtime.ts';

const Tally = z.object({ THREADS: z.number(), CREDENTIALS: z.number() });
const StubCalls = z.object({ worker: Tally, catalog: Tally });

test(
  'the list follows each session by its own writes, newest activity first, and never asks a session',
  { timeout: 120_000 },
  async () => {
    const rig = await lifecycleRig();
    const held: Array<() => void> = [];

    const list = async (query = '') =>
      ListSessionsResponse.parse(await (await rig.api('/v1/sessions' + query)).json()).sessions;

    const row = async (id: string) => (await list()).find((summary) => summary.id === id);

    const until = async (id: string, done: (summary: SessionSummary) => boolean) =>
      waitFor(async () => {
        const summary = await row(id);

        return summary && done(summary) ? summary : undefined;
      });

    const stubCalls = async () => StubCalls.parse(await (await fetch(new URL('/test/stub-calls', rig.base()))).json());

    try {
      const a = await rig.create();
      const b = await rig.create();
      const c = await rig.create();
      assert.deepEqual(
        (await list()).map(({ id }) => id),
        [c.id, b.id, a.id],
        'a new session is listed at once, newest first',
      );

      // A run the model holds open: the list says running, with the first message as title and preview.
      rig.setAnswer(
        (_, request) =>
          new Promise<WorkerResponse>((resolve) => {
            const finish = () => resolve(modelAnswer(model.id, [], { text: 'All  tests\npass now' }));
            held.push(finish);
            request.signal.addEventListener('abort', finish, { once: true });
          }),
      );

      const receipt = await rig.accepted(await rig.send(a.id, 'Fix the flaky test\nin the parser'));

      const running = await until(a.id, (summary) => summary.run.kind === 'running');
      assert.equal(running.title, 'Fix the flaky test');
      assert.equal(running.preview, 'Fix the flaky test in the parser');
      assert.equal(running.openRequests, 0);
      assert.equal((await list())[0]?.id, a.id, 'its message moved it to the top');

      // It finishes with no client connected: only the list is read.
      await waitFor(() => held.length > 0 || undefined);

      for (const finish of held) finish();
      const finished = await until(a.id, (summary) => summary.run.kind === 'completed');
      assert.deepEqual(finished.run, { kind: 'completed', runId: receipt.runId });
      assert.equal(finished.preview, 'All tests pass now');
      assert.ok(finished.updatedAt > running.createdAt);
      rig.setAnswer(undefined);

      // A question the agent asks counts as an open request until it is answered.
      const ask = { id: crypto.randomUUID(), name: 'ask_user_question', arguments: { questions: [question] } };
      await rig.accepted(await rig.send(b.id, 'Pick a cache', undefined, ask));
      await until(b.id, (summary) => summary.openRequests === 1 && summary.run.kind === 'completed');
      const [asked] = (await rig.session(b.id)).questions;
      assert.ok(asked);
      const answered = await rig.api(`/v1/sessions/${b.id}/questions/${asked.id}`, { decline: true });
      assert.equal(answered.status, 200, await answered.clone().text());
      await until(b.id, (summary) => summary.openRequests === 0);

      // A rename moves the title, not the order: activity is the newest message.
      const order = (await list()).map(({ id }) => id);
      const renamed = await rig.api(`/v1/sessions/${c.id}`, { title: 'Release notes' }, 'PATCH');
      assert.equal(renamed.status, 200, await renamed.clone().text());
      await until(c.id, (summary) => summary.title === 'Release notes');
      assert.deepEqual(
        (await list()).map(({ id }) => id),
        order,
      );

      // Paging walks every row once, in order, and listing asks no session and no credentials.
      const before = await stubCalls();
      assert.ok(before.catalog.THREADS > 0, 'the Catalog counts the Threads it asks, as at creation');
      const pages: string[] = [];
      let cursor: string | null = null;

      do {
        const query: string = cursor ? `?limit=1&cursor=${encodeURIComponent(cursor)}` : '?limit=1';
        const page = ListSessionsResponse.parse(await (await rig.api('/v1/sessions' + query)).json());
        pages.push(...page.sessions.map(({ id }) => id));
        cursor = page.nextCursor;
      } while (cursor);

      assert.deepEqual(pages, order);
      const after = await stubCalls();
      assert.equal(after.worker.THREADS, before.worker.THREADS);
      assert.deepEqual(after.catalog, before.catalog);
    } finally {
      for (const finish of held) finish();
      await rig.close();
    }
  },
);

const question = {
  question: 'Which cache?',
  header: 'Cache',
  options: [
    { label: 'Redis', description: 'About Redis' },
    { label: 'LRU', description: 'About LRU' },
  ],
};

const id = crypto.randomUUID();
const conversation = `/v1/sessions/${id}/conversations/1`;
const operationId = crypto.randomUUID();

// Every route under /v1/sessions, with a body each would accept.
const routes: Array<[method: string, path: string, body?: object]> = [
  ['GET', '/v1/sessions'],
  ['POST', '/v1/sessions', { operationId }],
  ['GET', `/v1/sessions/${id}`],
  ['PATCH', `/v1/sessions/${id}`, { title: 'Named' }],
  ['POST', `${conversation}/messages`, { operationId, text: 'Hello' }],
  ['POST', `${conversation}/cancel`, { operationId, runId: operationId }],
  ['POST', `${conversation}/compact`, {}],
  ['GET', `${conversation}/snapshot`],
  ['GET', `${conversation}/events`],
  ['GET', `${conversation}/history`],
  ['GET', `/v1/sessions/${id}/operations/${operationId}`],
  ['POST', `/v1/sessions/${id}/questions/${operationId}`, { decline: true }],
  ['POST', `/v1/sessions/${id}/secret-requests/${operationId}`, { decline: true }],
];

test('session routes need sign-in, keep the body limit, and an unknown session stores nothing', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-routing-'));

  try {
    const mf = runtime(storage);

    try {
      const base = await mf.ready;

      for (const [method, path, body] of routes) {
        const init = { method, body: body && JSON.stringify(body) };
        const json = { 'Content-Type': 'application/json' };
        const anonymous = await fetch(new URL(path, base), { ...init, headers: json });

        assert.equal(anonymous.status, 401, `${method} ${path} without sign-in`);

        if (body) {
          const oversized = await fetch(new URL(path, base), { method, headers, body: 'x'.repeat(128 * 1024 + 1) });

          assert.equal(oversized.status, 413, `${method} ${path} with an oversized body`);
        }

        if (path === '/v1/sessions') continue;

        // For a session that doesn't exist, the 404 comes before a bad body or query, as it always has.
        const bad = body ? { method, body: '{"unexpected":true}' } : { method };
        const refused = await fetch(new URL(path + (body ? '' : '?limit=0'), base), { ...bad, headers });

        assert.equal(refused.status, 404, `${method} ${path} for an unknown session, with a bad request`);
        const unknown = await fetch(new URL(path, base), { ...init, headers });
        assert.equal(unknown.status, 404, `${method} ${path} for an unknown session`);
        assert.equal(ApiError.parse(await unknown.json()).error.code, 'session_not_found');
      }
    } finally {
      await mf.dispose();
    }

    // The Thread was reached for that ID and wrote nothing: no Pi tables, no key-value rows, only Miniflare's name.
    // `metadata.sqlite` is workerd's own, beside every object's database.
    const databases = (await threadDatabases(storage)).filter((path) => !path.endsWith('metadata.sqlite'));
    assert.equal(databases.length, 1);
    const database = new DatabaseSync(databases[0] ?? '', { readOnly: true });

    try {
      const tables = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all();
      assert.deepEqual(
        tables.map(({ name }) => name),
        ['__miniflare_do_name'],
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});
