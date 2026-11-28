/**
 * Path: server/test/git-proxy.test.ts
 * Used by: pnpm test.
 * Purpose: A real git client clones, fetches and pushes through the proxy, which adds the installation token and forwards every push.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { branchSuffix } from '../src/git/repos.ts';
import { createSession, getSession, gitToken, gitWorker } from './git-env.ts';
import { FakeGitHub } from './github-fake.ts';
import { sandboxFile, sandboxRun, storedText, waitFor } from './rig.ts';

test(
  'a real git client clones, fetches and pushes through the proxy, and the installation token stays in the Worker',
  { timeout: 180_000 },
  async () => {
    const fake = await FakeGitHub.create();
    await fake.repo('octo', 'hello', { private: true });
    await fake.repo('octo', 'other');
    const worker = await gitWorker(fake, 8792);
    const { api, base } = worker;

    try {
      // Creation registers the base and clones it in the sandbox through the Worker.
      const created = await createSession(api, 'https://github.com/Octo/Hello.git');
      const workspace = created.workspace.id;
      assert.deepEqual(created.repos, [{ url: 'https://github.com/octo/hello', path: 'hello', base: true }]);
      await waitFor(() => sandboxFile(workspace, 'hello/README')).catch(async (error: Error) => {
        const state = await sandboxRun(
          workspace,
          'ls -la . .cloud-swe; cat .gitconfig .cloud-swe/git.config | sed s/Bearer.*/Bearer-redacted/; git ls-remote cloud-swe::https://github.com/octo/hello',
        );

        throw new Error(`${error.message}\n${state.output}\n${fake.gitCalls.join('\n')}`);
      });

      // The private repo was fetched with the installation token, which only the Worker holds.
      const basic = 'Basic ' + Buffer.from(`x-access-token:${fake.installationToken('octo')}`).toString('base64');
      assert.ok(fake.gitAuth.every((header) => header === basic));
      const leak = await sandboxRun(workspace, `grep -rl ghs_fake_installation "$HOME" /tmp 2>/dev/null; true`);
      assert.equal(leak.output.trim(), '');
      const config = await sandboxFile(workspace, '.cloud-swe/git.config');
      assert.ok(config && !config.includes(fake.installationToken('octo')));

      // The bot is the author, the signed-in account is credited below; origin shows github.com, which is where gh
      // looks for the repository, while the remote helper carries its traffic to the proxy.
      const identity = await sandboxRun(
        workspace,
        'git -C hello config user.name; git -C hello config user.email; git -C hello remote get-url origin; git -C hello remote get-url --push origin',
      );

      assert.equal(
        identity.output,
        'cloud-swe[bot]\n332717987+cloud-swe[bot]@users.noreply.github.com\nhttps://github.com/octo/hello\nhttps://github.com/octo/hello\n',
      );

      // Push to the session branch works.
      const branch = `cloud-swe/work-${branchSuffix(created.id)}`;

      const pushed = await sandboxRun(
        workspace,
        `cd hello && git checkout -q -b work && echo one > one.txt && git add one.txt && git commit -qm one && git push origin HEAD:${branch} && git rev-parse HEAD`,
      );

      assert.equal(pushed.code, 0, pushed.output);
      const tip = pushed.output.trim().split('\n').at(-1);
      assert.equal(await fake.sha('octo', 'hello', branch), tip);
      // This sandbox mounts /workspace noexec, so Git skips the hook here. git-access.test.ts runs it, and the E2B driver proves it live.
      assert.match(
        (await sandboxFile(workspace, 'hello/.git/hooks/prepare-commit-msg')) ?? '',
        /Octo Cat <42\+octo@users\.noreply\.github\.com>/,
      );

      // Every push is forwarded as git sent it: to main, forced, a delete and a tag.
      const toMain = await sandboxRun(workspace, 'cd hello && git push origin HEAD:main');
      assert.equal(toMain.code, 0, toMain.output);
      assert.equal(await fake.sha('octo', 'hello', 'main'), tip);

      const forced = await sandboxRun(
        workspace,
        `cd hello && git commit -q --amend -m two && git push --force origin HEAD:${branch} && git rev-parse HEAD`,
      );

      assert.equal(forced.code, 0, forced.output);
      assert.equal(await fake.sha('octo', 'hello', branch), forced.output.trim().split('\n').at(-1));

      const tagged = await sandboxRun(workspace, 'cd hello && git tag v1 && git push origin v1');
      assert.equal(tagged.code, 0, tagged.output);
      assert.equal(await fake.hasTag('octo', 'hello', 'v1'), true);

      const deleted = await sandboxRun(workspace, `cd hello && git push origin :${branch}`);
      assert.equal(deleted.code, 0, deleted.output);
      assert.equal(await fake.sha('octo', 'hello', branch), undefined);

      // A repository the session never registered is reachable too.
      const foreign = await sandboxRun(
        workspace,
        'git ls-remote cloud-swe::https://github.com/octo/other.git && cd hello && git push cloud-swe::https://github.com/octo/other.git HEAD:refs/heads/from-hello && git rev-parse HEAD',
      );

      assert.equal(foreign.code, 0, foreign.output);
      assert.equal(await fake.sha('octo', 'other', 'from-hello'), foreign.output.trim().split('\n').at(-1));

      // Crafted requests against the Worker itself.
      const token = await gitToken(workspace);

      assert.ok(token);
      const session = await getSession(api, created.id);
      assert.equal(session.repos.length, 1);

      const proxy = (sessionId: string, repo: string, operation: string, init: RequestInit = {}) =>
        fetch(new URL(`/git/${sessionId}/github.com/${repo}.git/${operation}`, base), init);

      const bearer = (value: string) => ({ Authorization: `Bearer ${value}` });
      const refs = 'info/refs?service=git-upload-pack';
      const upstream = fake.gitCalls.length;

      assert.equal((await proxy(created.id, 'octo/hello', refs)).status, 401);
      assert.equal((await proxy(created.id, 'octo/hello', refs, { headers: bearer('f'.repeat(64)) })).status, 401);
      assert.equal((await proxy(crypto.randomUUID(), 'octo/hello', refs, { headers: bearer(token) })).status, 401);
      assert.equal(
        (await proxy(created.id, 'octo/hello', 'info/refs?service=git-evil', { headers: bearer(token) })).status,
        405,
      );
      assert.equal((await proxy(created.id, 'octo/hello', 'git-receive-pack', { headers: bearer(token) })).status, 405);
      assert.equal((await fetch(new URL(`/git/${created.id}/gitlab.com/octo/hello.git/${refs}`, base))).status, 404);
      assert.equal((await fetch(new URL(`/git/${created.id}/github.com/octo/hello/extra/${refs}`, base))).status, 404);
      assert.equal(fake.gitCalls.length, upstream, 'rejected requests never reach GitHub');

      // An upstream redirect is refused, not followed.
      fake.redirectGit = true;
      const redirected = await proxy(created.id, 'octo/hello', refs, { headers: bearer(token) });
      assert.equal(redirected.status, 502);
      assert.equal(redirected.headers.get('Location'), null);
      fake.redirectGit = false;

      // The installation token is in no Thread or Pi record.
      assert.equal((await storedText(worker.storage)).includes(fake.installationToken('octo')), false);
    } finally {
      await worker.close();
    }
  },
);

test(
  "an account without the GitHub App goes anonymously, and a token covers its account's whole installation",
  { timeout: 120_000 },
  async () => {
    const fake = await FakeGitHub.create();
    await fake.repo('other', 'public');
    await fake.repo('octo', 'hello', { private: true });
    await fake.repo('octo', 'second', { private: true });
    fake.notInstalled.add('other');
    const worker = await gitWorker(fake, 8803);
    const { api } = worker;

    try {
      const session = await createSession(api, 'https://github.com/other/public');
      await waitFor(() => sandboxFile(session.workspace.id, 'public/README'));
      assert.ok(fake.gitAuth.length > 0);
      assert.ok(fake.gitAuth.every((header) => header === null));
      assert.deepEqual(fake.minted, []);

      // One token, minted without a repository list, serves both of the account's private repositories.
      for (const repo of ['hello', 'second']) {
        const installed = await createSession(api, `https://github.com/octo/${repo}`);
        await waitFor(() => sandboxFile(installed.workspace.id, `${repo}/README`));
      }

      assert.deepEqual(fake.minted, ['octo']);
    } finally {
      await worker.close();
    }
  },
);

test('a failed GitHub token lookup is remembered, so the next request fails fast', { timeout: 120_000 }, async () => {
  const fake = await FakeGitHub.create();
  await fake.repo('octo', 'hello');
  fake.appDown = true;
  const worker = await gitWorker(fake, 8807);

  try {
    // The clone at creation is the first lookup, and it fails.
    const session = await createSession(worker.api, 'https://github.com/octo/hello');
    await waitFor(
      () => fake.appRequests,
      (requests) => requests > 0,
    );
    const token = await waitFor(() => gitToken(session.workspace.id), Boolean);
    // Long enough for the Worker to have read that failure.
    await setTimeout(1000);
    const before = fake.appRequests;

    for (let attempt = 0; attempt < 2; attempt++) {
      const refs = await fetch(
        new URL(`/git/${session.id}/github.com/octo/hello.git/info/refs?service=git-upload-pack`, worker.base),
        { headers: { Authorization: `Bearer ${token}` } },
      );

      assert.equal(refs.status, 502);
    }

    assert.equal(fake.appRequests, before);
  } finally {
    await worker.close();
  }
});

test("GitHub's 429s are retried, and a push body is sent again", { timeout: 180_000 }, async () => {
  const fake = await FakeGitHub.create();
  await fake.repo('octo', 'hello');
  const worker = await gitWorker(fake, 8804);

  try {
    const created = await createSession(worker.api, 'https://github.com/octo/hello');
    const workspace = created.workspace.id;
    await waitFor(() => sandboxFile(workspace, 'hello/README'));
    const branch = `cloud-swe/work-${branchSuffix(created.id)}`;
    fake.refuseGit = 2;

    const pushed = await sandboxRun(
      workspace,
      `cd hello && git checkout -q -b work && echo one > one.txt && git add one.txt && git commit -qm one && git push origin HEAD:${branch} && git rev-parse HEAD`,
    );

    assert.equal(pushed.code, 0, pushed.output);
    assert.equal(fake.refuseGit, 0);
    assert.equal(await fake.sha('octo', 'hello', branch), pushed.output.trim().split('\n').at(-1));

    // When the refusals outlast the retries, git fails with a status it can report.
    fake.refuseGit = 6;
    const refused = await sandboxRun(workspace, 'cd hello && git ls-remote origin', 100_000);
    assert.notEqual(refused.code, 0);
    assert.match(refused.output, /429/);
    assert.equal(fake.refuseGit, 0);
  } finally {
    await worker.close();
  }
});

test('a push large enough for git to probe first is forwarded whole', { timeout: 180_000 }, async () => {
  const fake = await FakeGitHub.create();
  await fake.repo('octo', 'hello');
  const worker = await gitWorker(fake, 8795);

  try {
    const created = await createSession(worker.api, 'https://github.com/octo/hello');
    const workspace = created.workspace.id;
    await waitFor(() => sandboxFile(workspace, 'hello/README'));
    const branch = `cloud-swe/work-${branchSuffix(created.id)}`;

    // Over 1 MiB, git sends a bare flush-pkt first to find out whether the server wants credentials.
    const big = await sandboxRun(
      workspace,
      `cd hello && head -c 2500000 /dev/urandom > big.bin && git add big.bin && git commit -qm big && git push origin HEAD:${branch} && git rev-parse HEAD`,
    );

    assert.equal(big.code, 0, big.output);
    assert.equal(await fake.sha('octo', 'hello', branch), big.output.trim().split('\n').at(-1));
  } finally {
    await worker.close();
  }
});
