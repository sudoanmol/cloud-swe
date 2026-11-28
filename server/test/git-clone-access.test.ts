/**
 * Path: server/test/git-clone-access.test.ts
 * Used by: pnpm test.
 * Purpose: git_clone keeps a fresh token, reports only a Git access failure as unavailable, and the keep-alive replaces a token during a long run.
 */

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { branchSuffix } from '../src/git/repos.ts';
import { createSession, gitToken, gitWorker, send, settled } from './git-env.ts';
import { FakeGitHub } from './github-fake.ts';
import { lifecycleRig } from './lifecycle-rig.ts';
import { toolResults } from './provider-request.ts';
import { type Call, sandboxFile, sandboxRun, threadDatabases, waitFor } from './rig.ts';

/**
 * Expires every stored Git token as an hour passing would. The Worker has no setting for the token lifetime, and Durable
 * Object KV can only be written from outside through a stopped Worker's SQLite files.
 */
async function forgetGitAccess(storage: string): Promise<number> {
  let removed = 0;

  for (const path of await threadDatabases(storage)) {
    const database = new DatabaseSync(path);
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
      await waitFor(() => sandboxFile(workspace, 'hello/README'));
      const original = await config();
      assert.ok(original);

      const clone = async (name: string) => {
        calls.push([{ id: 'clone-' + name, name: 'git_clone', arguments: { url: `https://github.com/octo/${name}` } }]);
        await send(api, session.id, 'Clone ' + name);
        await settled(api, session.id);
        await waitFor(() => sandboxFile(workspace, `${name}/README`));
      };

      await clone('other');
      assert.equal(await config(), original, 'a fresh token is reused');

      await sandboxRun(workspace, 'rm .cloud-swe/git.config');
      await clone('third');
      const rewritten = await config();
      assert.ok(rewritten);
      assert.notEqual(rewritten, original, 'a sandbox without the config gets a new one');
    } finally {
      await worker.close();
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
      await waitFor(() => sandboxFile(workspace, 'hello/README'));
      const original = await config();
      const token = await gitToken(workspace);
      assert.ok(token);

      const branch = `cloud-swe/long-${branchSuffix(session.id)}`;

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
      await waitFor(() => sandboxFile(workspace, 'started'));

      // The hour passes during a restart: no stored token is valid any more, as if every one had expired.
      await worker.restart(async () => assert.equal(await forgetGitAccess(worker.storage), 1));

      const refs = new URL(`/git/${session.id}/github.com/octo/hello.git/info/refs?service=git-upload-pack`, base);
      const expired = await fetch(refs, { headers: { Authorization: 'Bearer ' + token } });
      assert.equal(expired.status, 401, 'the original token no longer works');

      await waitFor(config, (current) => current !== original);

      await sandboxRun(workspace, 'touch go');
      const done = await settled(api, session.id);
      assert.equal(done.run.kind, 'completed');
      const result = toolResults(bodies.at(-1) ?? '').at(-1);
      assert.equal(result?.isError, false, result?.output);
      assert.match(result?.output ?? '', /after-the-hour/);
    } finally {
      await worker.close();
    }
  },
);

test('git_clone reports Git access as unavailable only when Git access itself fails', { timeout: 60_000 }, async () => {
  const rig = await lifecycleRig();
  const down = () => new Response('sandbox unavailable', { status: 503 });

  const clone = async (id: string, repo: string) => {
    const call = { id: crypto.randomUUID(), name: 'git_clone', arguments: { url: 'https://github.com/octo/' + repo } };
    await rig.accepted(await rig.send(id, 'Clone ' + repo, undefined, call));
    await rig.settled(id);

    return toolResults(rig.bodies.at(-1) ?? '').at(-1);
  };

  try {
    const session = await rig.create();

    // The clone's own read of the sandbox root is the third this round: admission and Pi's tool environment read first.
    let reads = 0;
    rig.setIntercept((r) => (r.method === 'GET' && r.path.endsWith('/info') && ++reads === 3 ? down() : undefined));
    const root = await clone(session.id, 'hello');
    assert.equal(root?.isError, true);
    assert.doesNotMatch(root?.output ?? '', /Git access is unavailable/);

    rig.setIntercept((r) => (r.method === 'POST' && r.body.includes('git.config') ? down() : undefined));
    const access = await clone(session.id, 'other');
    assert.equal(access?.isError, true);
    assert.match(access?.output ?? '', /Git access is unavailable/);
  } finally {
    await rig.close();
  }
});
