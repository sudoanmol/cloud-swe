import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';

import { GitHubCredentialStatus } from '@cloud-swe/protocol/credentials';

import { concat, FLUSH, pkt } from '../src/git/pktline.ts';
import { createSession, getSession, gitWorker, sandboxFile, sandboxRun, until } from './git-env.ts';
import { FakeGitHub } from './github-fake.ts';

const ZERO = '0'.repeat(40);

test(
  'a real git client clones, fetches and pushes through the proxy under the push policy, and the PAT stays in the Worker',
  { timeout: 180_000 },
  async () => {
    const fake = await FakeGitHub.create();
    await fake.repo('octo', 'hello', { private: true });
    await fake.repo('octo', 'other');
    const worker = await gitWorker(fake, 8792);
    const { api, base } = worker;

    try {
      // PAT: write-only, metadata only, validated against GitHub.
      assert.equal((await api('/v1/credentials/github', 'PUT', { token: 'ghp_wrong' })).status, 400);
      const set = await api('/v1/credentials/github', 'PUT', { token: fake.pat });
      assert.equal(set.headers.get('Cache-Control'), 'no-store');
      const setText = await set.text();
      assert.deepEqual(GitHubCredentialStatus.parse(JSON.parse(setText)), { configured: true, login: 'octo' });
      assert.equal(setText.includes(fake.pat), false);
      assert.equal((await (await api('/v1/credentials/github')).text()).includes(fake.pat), false);
      assert.equal((await fetch(new URL('/v1/credentials/github', base))).status, 401);

      // Creation registers the base and clones it in the sandbox through the Worker.
      const created = await createSession(api, 'https://github.com/Octo/Hello.git');
      const workspace = created.workspace.id;
      assert.deepEqual(created.repos, [{ url: 'https://github.com/octo/hello', path: 'hello', base: true }]);
      await until(() => sandboxFile(workspace, 'hello/README'), 'the clone', 300).catch(async (error: Error) => {
        const state = await sandboxRun(
          workspace,
          'ls -la . .cloud-swe; cat .gitconfig .cloud-swe/git.config | sed s/Bearer.*/Bearer-redacted/; git ls-remote https://github.com/octo/hello',
        );

        throw new Error(`${error.message}\n${state.output}\n${fake.gitCalls.join('\n')}`);
      });

      // The private repo was fetched with the PAT, which only the Worker holds.
      const basic = 'Basic ' + Buffer.from(`x-access-token:${fake.pat}`).toString('base64');
      assert.ok(fake.gitAuth.every((header) => header === basic));
      const leak = await sandboxRun(workspace, `grep -rl ghp_fake_personal "$HOME" /tmp 2>/dev/null; true`);
      assert.equal(leak.output.trim(), '');
      const config = await sandboxFile(workspace, '.cloud-swe/git.config');
      assert.ok(config && !config.includes(fake.pat));

      // Identity comes from the PAT's account; origin keeps a readable URL.
      const identity = await sandboxRun(
        workspace,
        'git -C hello config user.name; git -C hello config user.email; git -C hello config remote.origin.url',
      );

      assert.equal(identity.output, 'Octo Cat\nocto@example.com\nhttps://github.com/octo/hello\n');

      // Push to the session branch works.
      const branch = `cloud-swe/work-${created.id.slice(0, 8)}`;

      const pushed = await sandboxRun(
        workspace,
        `cd hello && git checkout -q -b work && echo one > one.txt && git add one.txt && git commit -qm one && git push origin HEAD:${branch} && git rev-parse HEAD`,
      );

      assert.equal(pushed.code, 0, pushed.output);
      const tip = pushed.output.trim().split('\n').at(-1);
      assert.equal(await fake.sha('octo', 'hello', branch), tip);

      // Everything else is refused with a reason git prints, and GitHub never changes.
      const main = await fake.sha('octo', 'hello', 'main');

      const attempts: [string, string][] = [
        ['main', 'cd hello && git push origin HEAD:main'],
        ['another branch', 'cd hello && git push origin HEAD:refs/heads/other'],
        ['a tag', 'cd hello && git tag v1 && git push origin v1'],
        ['a delete', `cd hello && git push origin :${branch}`],
        ['two refs', `cd hello && git push origin HEAD:${branch} HEAD:other`],
      ];

      for (const [name, script] of attempts) {
        const refused = await sandboxRun(workspace, script);
        assert.notEqual(refused.code, 0, name);
        assert.match(refused.output, /remote rejected|rejected/, name + ': ' + refused.output);
      }

      assert.equal(await fake.sha('octo', 'hello', 'main'), main);
      assert.equal(await fake.sha('octo', 'hello', branch), tip);
      assert.equal(await fake.sha('octo', 'hello', 'other'), undefined);

      // A refused delete or tag reaches the user, once per change, and only their decision applies it.
      const blocked = async () => {
        const session = await getSession(api, created.id);

        return session.approvals.filter((approval) => approval.kind === 'ref_change');
      };

      const decide = (id: string, decision: 'approve' | 'reject') =>
        api(`/v1/sessions/${created.id}/approvals/${id}`, 'POST', { decision });

      assert.equal((await blocked()).length, 2);
      const again = await sandboxRun(workspace, 'cd hello && git push origin v1');
      assert.match(again.output, /sent to the user/);
      assert.equal((await blocked()).length, 2, 'a retried push files nothing new');

      const tagApproval = (await blocked()).find((approval) => approval.ref === 'refs/tags/v1');
      const deleteApproval = (await blocked()).find((approval) => approval.sha === null);
      assert.ok(tagApproval && deleteApproval);
      assert.equal(await fake.hasTag('octo', 'hello', 'v1'), false);
      assert.equal((await decide(tagApproval.id, 'approve')).status, 200);
      assert.equal(await fake.hasTag('octo', 'hello', 'v1'), true);
      assert.equal((await decide(deleteApproval.id, 'reject')).status, 200);
      assert.equal(await fake.sha('octo', 'hello', branch), tip, 'a blocked delete changes nothing');
      assert.match((await sandboxRun(workspace, `cd hello && git push origin :${branch}`)).output, /blocked this push/);

      // A force push is applied, noticed, reverted and reported; the rejected commit stays for the approval path.
      const forced = await sandboxRun(
        workspace,
        `cd hello && git commit -q --amend -m two && git push --force origin HEAD:${branch}; git rev-parse HEAD`,
      );

      assert.match(forced.output, /force push requires approval: use git_request_ref_update/);
      const forcedSha = forced.output.trim().split('\n').at(-1) ?? '';
      assert.equal(await fake.sha('octo', 'hello', branch), tip);
      assert.equal(await fake.hasCommit('octo', 'hello', forcedSha), true);

      // A fast-forward push after it still works.
      const next = await sandboxRun(
        workspace,
        `cd hello && git reset -q --hard ${tip} && echo two > two.txt && git add two.txt && git commit -qm two && git push origin HEAD:${branch}`,
      );

      assert.equal(next.code, 0, next.output);

      // An unregistered repo is not reachable even though it exists.
      const before = fake.gitCalls.length;
      const foreign = await sandboxRun(workspace, 'git ls-remote https://github.com/octo/other.git');
      assert.notEqual(foreign.code, 0);
      assert.equal(fake.gitCalls.length, before, 'no upstream call for a foreign repo');

      // Crafted requests against the Worker itself.
      const token =
        /Bearer ([0-9a-f]{64})/.exec((await sandboxFile(workspace, '.cloud-swe/git.config')) ?? '')?.[1] ?? '';

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
      assert.equal((await proxy(created.id, 'octo/other', refs, { headers: bearer(token) })).status, 403);
      assert.equal(
        (await proxy(created.id, 'octo/hello', 'info/refs?service=git-evil', { headers: bearer(token) })).status,
        405,
      );
      assert.equal((await proxy(created.id, 'octo/hello', 'git-receive-pack', { headers: bearer(token) })).status, 405);
      assert.equal((await fetch(new URL(`/git/${created.id}/gitlab.com/octo/hello.git/${refs}`, base))).status, 404);
      assert.equal((await fetch(new URL(`/git/${created.id}/github.com/octo/hello/extra/${refs}`, base))).status, 404);
      assert.equal(fake.gitCalls.length, upstream, 'rejected requests never reach GitHub');

      const crafted = async (commands: string[], capabilities = 'report-status side-band-64k') =>
        proxy(created.id, 'octo/hello', 'git-receive-pack', {
          method: 'POST',
          headers: { ...bearer(token), 'Content-Type': 'application/x-git-receive-pack-request' },
          body: concat([
            ...commands.map((command, index) =>
              pkt(new TextEncoder().encode(command + (index === 0 ? '\0' + capabilities : ''))),
            ),
            FLUSH,
            new TextEncoder().encode('PACK'),
          ]),
        });

      for (const command of [
        `${tip} ${tip} refs/heads/main`,
        `${ZERO} ${tip} refs/tags/v9`,
        `${tip} ${ZERO} ${`refs/heads/${branch}`}`,
      ]) {
        const response = await crafted([command]);
        assert.equal(response.status, 200);
        assert.match(await response.text(), /ng refs\/[^ ]+ /);
      }

      assert.equal((await crafted([`${tip} ${tip} refs/heads/main`], 'agent=x')).status, 403);
      assert.equal(fake.gitCalls.length, upstream, 'refused pushes never reach GitHub');

      // An upstream redirect is refused, not followed.
      fake.redirectGit = true;
      const redirected = await proxy(created.id, 'octo/hello', refs, { headers: bearer(token) });
      assert.equal(redirected.status, 502);
      assert.equal(redirected.headers.get('Location'), null);
      fake.redirectGit = false;

      // The PAT is in no Thread or Pi record.
      const database = await worker.mf.unsafeGetDurableObjectStorage('cloud-swe-server', 'Thread', {
        name: created.id,
      });

      const tables = ['pi_entries', 'pi_tasks', 'pi_submissions', 'pi_documents'];

      for (const table of tables) {
        const rows = JSON.stringify(
          (await database.exec(`SELECT * FROM ${table}`)).map((row) =>
            Object.values(row).map((value) =>
              value instanceof ArrayBuffer ? Buffer.from(value).toString('latin1') : String(value),
            ),
          ),
        );

        assert.equal(rows.includes(fake.pat), false, table);
      }
    } finally {
      await worker.mf.dispose();
      await rm(worker.storage, { recursive: true, force: true });
      await rm(fake.root, { recursive: true, force: true });
    }
  },
);
