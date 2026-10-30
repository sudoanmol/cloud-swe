import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';

import type { ToolCall } from '@earendil-works/pi-ai';

import { createSession, gitWorker, sandboxFile, sandboxRun, send, settled, until } from './git-env.ts';
import { FakeGitHub } from './github-fake.ts';

type Call = Pick<ToolCall, 'id' | 'name' | 'arguments'>;

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
      assert.equal((await api('/v1/credentials/github', 'PUT', { token: fake.pat })).status, 200);
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
