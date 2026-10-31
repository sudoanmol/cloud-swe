import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { concat, FLUSH, pkt } from '../src/git/pktline.ts';
import { createSession, gitWorker, sandboxFile, sandboxRun, until } from './git-env.ts';
import { FakeGitHub } from './github-fake.ts';

const run = promisify(execFile);

const identity = { GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x' };

/** A pack with no objects: enough for receive-pack when the objects it needs are already in the repository. */
function emptyPack() {
  const head = Buffer.concat([Buffer.from('PACK'), Buffer.from([0, 0, 0, 2, 0, 0, 0, 0])]);

  return Buffer.concat([head, createHash('sha1').update(head).digest()]);
}

test(
  'the proxy forwards git large-push probes, and checks every accepted update for a force push',
  { timeout: 180_000 },
  async () => {
    const fake = await FakeGitHub.create();
    await fake.repo('octo', 'hello');
    const worker = await gitWorker(fake, 8795);
    const { api, base } = worker;

    try {
      const created = await createSession(api, 'https://github.com/octo/hello');
      const workspace = created.workspace.id;
      await until(() => sandboxFile(workspace, 'hello/README'), 'the clone', 300);
      const branch = `cloud-swe/work-${created.id.slice(0, 8)}`;

      // Over 1 MiB, git sends a bare flush-pkt first to find out whether the server wants credentials.
      const big = await sandboxRun(
        workspace,
        `cd hello && head -c 2500000 /dev/urandom > big.bin && git add big.bin && git commit -qm big && git push origin HEAD:${branch} && git rev-parse HEAD`,
      );

      assert.equal(big.code, 0, big.output);
      const tip = big.output.trim().split('\n').at(-1);
      assert.equal(await fake.sha('octo', 'hello', branch), tip);

      // A forced update from a client that asked for no report-status leaves nothing to read in the reply.
      const bare = join(fake.root, 'octo', 'hello.git');

      const rogue = (
        await run('git', ['-C', bare, 'commit-tree', `${tip}^{tree}`, '-m', 'rogue'], {
          env: { ...process.env, ...identity },
        })
      ).stdout.trim();

      const token =
        /Bearer ([0-9a-f]{64})/.exec((await sandboxFile(workspace, '.cloud-swe/git.config')) ?? '')?.[1] ?? '';

      assert.ok(token);

      const force = () =>
        fetch(new URL(`/git/${created.id}/github.com/octo/hello.git/git-receive-pack`, base), {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-git-receive-pack-request' },
          body: concat([
            pkt(new TextEncoder().encode(`${tip} ${rogue} refs/heads/${branch}\0agent=x`)),
            FLUSH,
            emptyPack(),
          ]),
        });

      const refused = await force();
      assert.equal(refused.status, 403);
      assert.match(await refused.text(), /force push requires approval/);
      assert.equal(await fake.sha('octo', 'hello', branch), tip, 'the forced update was reverted');

      // When GitHub cannot confirm the revert, the reply says so instead of passing the push on as accepted.
      fake.lose.push({ pattern: /^PATCH \/repos\/octo\/hello\/git\/refs\//, used: false });
      const unconfirmed = await force();
      assert.equal(unconfirmed.status, 403);
      assert.match(await unconfirmed.text(), /could not be reverted/);
    } finally {
      await worker.mf.dispose();
      await rm(worker.storage, { recursive: true, force: true });
      await rm(fake.root, { recursive: true, force: true });
    }
  },
);
