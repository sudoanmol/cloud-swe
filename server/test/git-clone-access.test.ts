/**
 * Path: server/test/git-clone-access.test.ts
 * Used by: pnpm test.
 * Purpose: git_clone keeps a fresh token and the keep-alive replaces one during a long run.
 */

import assert from 'node:assert/strict';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import type { ToolCall } from '@earendil-works/pi-ai';

import { toolResults } from '../../protocol/test/provider-request.ts';
import { createSession, gitWorker, sandboxFile, sandboxRun, send, settled, until } from './git-env.ts';
import { FakeGitHub } from './github-fake.ts';

type Call = Pick<ToolCall, 'id' | 'name' | 'arguments'>;

/** Durable Object KV can only be written from outside through the stopped Worker's SQLite files. */
async function forgetGitAccess(storage: string): Promise<number> {
  const files = await readdir(storage, { recursive: true });
  let removed = 0;

  for (const file of files.filter((name) => name.endsWith('.sqlite') && name.includes('SessionThread'))) {
    const database = new DatabaseSync(join(storage, file));
    const kv = database.prepare(`SELECT 1 FROM sqlite_master WHERE name = '_cf_KV'`).get();

    if (kv) removed += Number(database.prepare(`DELETE FROM _cf_KV WHERE key = 'gitAccess'`).run().changes);
    database.close();
  }

  return removed;
}

test(
  'git_clone keeps a fresh token and rewrites the config only when it is missing, as in a replaced sandbox',
  { timeout: 120_000 },
  async () => {
    const fake = await FakeGitHub.create();
    await fake.repo('octo', 'hello');
    await fake.repo('octo', 'other');
    await fake.repo('octo', 'third');
    const calls: Call[][] = [];
    const worker = await gitWorker(fake, 8797, calls);
    const { api } = worker;

    try {
      const session = await createSession(api, 'https://github.com/octo/hello');
      const workspace = session.workspace.id;
      const config = () => sandboxFile(workspace, '.cloud-swe/git.config');
      await until(() => sandboxFile(workspace, 'hello/README'), 'the first clone', 300);
      const original = await config();
      assert.ok(original);

      const clone = async (name: string) => {
        calls.push([{ id: 'clone-' + name, name: 'git_clone', arguments: { url: `https://github.com/octo/${name}` } }]);
        await send(api, session.id, 'Clone ' + name);
        await settled(api, session.id);
        await until(() => sandboxFile(workspace, `${name}/README`), `the ${name} clone`, 300);
      };

      await clone('other');
      assert.equal(await config(), original, 'a fresh token is reused');

      await sandboxRun(workspace, 'rm .cloud-swe/git.config');
      await clone('third');
      const rewritten = await config();
      assert.ok(rewritten);
      assert.notEqual(rewritten, original, 'a sandbox without the config gets a new one');
    } finally {
      await worker.mf.dispose();
      await rm(worker.storage, { recursive: true, force: true });
      await rm(fake.root, { recursive: true, force: true });
    }
  },
);

test(
  'a run past the token hour gets a new token from the keep-alive, so its next fetch and push still work',
  { timeout: 120_000 },
  async () => {
    const fake = await FakeGitHub.create();
    await fake.repo('octo', 'hello');
    const calls: Call[][] = [];
    const bodies: string[] = [];
    const worker = await gitWorker(fake, 8798, calls, bodies, { KEEPALIVE_INTERVAL_SECONDS: '1' });
    const { api, base } = worker;

    try {
      const session = await createSession(api, 'https://github.com/octo/hello');
      const workspace = session.workspace.id;
      const config = () => sandboxFile(workspace, '.cloud-swe/git.config');
      await until(() => sandboxFile(workspace, 'hello/README'), 'the first clone', 300);
      const original = await config();
      const token = /Bearer (\w+)/.exec(original ?? '')?.[1];
      assert.ok(token);

      const branch = `cloud-swe/long-${session.id.slice(0, 8)}`;

      const command = [
        'touch started',
        'until [ -f go ]; do sleep 0.2; done',
        'cd hello',
        'git fetch origin',
        `git checkout -b ${branch}`,
        'git commit --allow-empty -m long',
        `git push origin ${branch}`,
        'printf after-the-hour',
      ].join(' && ');

      calls.push([{ id: 'long', name: 'bash', arguments: { command } }]);
      await send(api, session.id, 'Work for a long time');
      await until(() => sandboxFile(workspace, 'started'), 'the command to start', 300);

      // The hour passes during a restart: no stored token is valid any more, as if every one had expired.
      await worker.restart(async () => assert.equal(await forgetGitAccess(worker.storage), 1));

      const refs = new URL(`/git/${session.id}/github.com/octo/hello.git/info/refs?service=git-upload-pack`, base);
      const expired = await fetch(refs, { headers: { Authorization: 'Bearer ' + token } });
      assert.equal(expired.status, 401, 'the original token no longer works');

      await until(
        async () => ((await config()) === original ? undefined : true),
        'the keep-alive to write a new token',
        300,
      );

      await sandboxRun(workspace, 'touch go');
      const done = await settled(api, session.id);
      assert.equal(done.run.kind, 'completed');
      const result = toolResults(bodies.at(-1) ?? '').at(-1);
      assert.equal(result?.isError, false, result?.output);
      assert.match(result?.output ?? '', /after-the-hour/);
    } finally {
      await worker.mf.dispose();
      await rm(worker.storage, { recursive: true, force: true });
      await rm(fake.root, { recursive: true, force: true });
    }
  },
);
