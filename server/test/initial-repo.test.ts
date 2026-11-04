/**
 * Path: server/test/initial-repo.test.ts
 * Used by: pnpm test.
 * Purpose: The repo requested at creation is registered and cloned, or refused up front.
 */

import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';

import { ListSessionsResponse } from '@cloud-swe/protocol';

import { createSession, gitWorker, sandboxFile, until } from './git-env.ts';
import { FakeGitHub } from './github-fake.ts';

test(
  'the initial repo is registered with the session, a dot-named repo gets a usable directory, and an unusable one is refused up front',
  { timeout: 120_000 },
  async () => {
    const fake = await FakeGitHub.create();
    await fake.repo('octo', '.github');
    const worker = await gitWorker(fake, 8796);
    const { api } = worker;

    try {
      const session = await createSession(api, 'https://github.com/octo/.github');
      assert.deepEqual(session.repos, [{ url: 'https://github.com/octo/.github', path: 'github', base: true }]);
      await until(() => sandboxFile(session.workspace.id, 'github/README'), 'the clone', 300);

      const refused = await api('/v1/sessions', 'POST', {
        operationId: crypto.randomUUID(),
        template: 'base',
        model: session.model,
        repo: { url: 'https://example.com/~tilde' },
      });

      assert.equal(refused.status, 400);
      const listed = ListSessionsResponse.parse(await (await api('/v1/sessions')).json());
      assert.equal(listed.sessions.length, 1, 'no half-created session is left behind');
    } finally {
      await worker.mf.dispose();
      await rm(worker.storage, { recursive: true, force: true });
      await rm(fake.root, { recursive: true, force: true });
    }
  },
);
