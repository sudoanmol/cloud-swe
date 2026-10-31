/**
 * Path: server/test/git-policy.test.ts
 * Used by: pnpm test.
 * Purpose: The push parser and policy, capability tokens and repo authorization, without a running Worker where possible.
 */

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import { promisify } from 'node:util';

import { gitAuthorization, gitConfig, newToken, storeToken, tokenExpiring, tokenValid } from '../src/git/access.ts';
import { cloneScript } from '../src/git/clone.ts';
import { deterministicUuid } from '../src/git/ids.ts';
import {
  branchSuffix,
  checkPush,
  concat,
  FLUSH,
  MAX_COMMANDS_BYTES,
  parsePushRequest,
  pkt,
  pktText,
  readCommands,
  rejectionReport,
} from '../src/git/push.ts';
import { readRepos, registerRepo, setBaseRepo, unregisterRepo } from '../src/git/repos.ts';
import { sandboxReplacedNotice } from '../src/sessions/notice.ts';
import { createSession, gitWorker, sandboxFile, sandboxRun, until } from './git-env.ts';
import { FakeGitHub } from './github-fake.ts';

const ZERO = '0'.repeat(40);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const session = crypto.randomUUID();
const own = `refs/heads/cloud-swe/fix-login-${branchSuffix(session)}`;

class Memory {
  readonly map = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    // SAFETY: tests read back exactly what they put, so the stored value has the caller's type.
    return this.map.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, value);
  }
}

const memory = () => new Memory();

function push(commands: string[], capabilities = 'report-status side-band-64k') {
  return concat([
    ...commands.map((command, index) =>
      pkt(new TextEncoder().encode(command + (index === 0 ? '\0' + capabilities : ''))),
    ),
    FLUSH,
    new TextEncoder().encode('PACK-not-inspected'),
  ]);
}

test('the command list is parsed without touching the pack, and partial input asks for more bytes', () => {
  const body = push([`${A} ${B} ${own}`]);
  const parsed = parsePushRequest(body);

  assert.deepEqual(parsed?.commands, [{ old: A, new: B, ref: own }]);
  assert.deepEqual(parsed?.capabilities, ['report-status', 'side-band-64k']);
  assert.equal(body.length - (parsed?.length ?? 0), 'PACK-not-inspected'.length);
  assert.equal(parsePushRequest(body.subarray(0, 30)), undefined);
  assert.throws(() => parsePushRequest(new TextEncoder().encode('zzzz')), /Malformed/);
  assert.equal(parsePushRequest(push([`push-cert\0x`]))?.unsupported, true);
});

test('only one update to the session branch passes: no main, other branch, tag, delete or second ref', () => {
  const decide = (commands: string[]) => {
    const request = parsePushRequest(push(commands));
    assert.ok(request);

    return checkPush(request, session);
  };

  for (const command of [`${ZERO} ${B} refs/tags/v1`, `${A} ${ZERO} refs/tags/v1`, `${A} ${ZERO} refs/heads/main`]) {
    const decision = decide([command]);
    assert.ok(!decision.ok && decision.blocked, `${command} is sent to the user`);
  }

  const moved = decide([`${A} ${B} refs/tags/v1`]);
  assert.ok(!moved.ok && !moved.blocked, 'moving a tag has no approval path');

  assert.equal(decide([`${ZERO} ${B} ${own}`]).ok, true);
  assert.equal(decide([`${A} ${B} ${own}`]).ok, true);

  for (const rejected of [
    [`${A} ${B} refs/heads/main`],
    [`${A} ${B} refs/heads/other`],
    [`${A} ${B} refs/heads/cloud-swe/other-${crypto.randomUUID().slice(0, 8)}`],
    [`${A} ${B} refs/heads/cloud-swe/Bad_Slug-${branchSuffix(session)}`],
    [`${A} ${B} refs/heads/cloud-swe/${branchSuffix(session)}`],
    [`${ZERO} ${B} refs/tags/v1`],
    [`${A} ${ZERO} ${own}`],
    [`${A} ${B} ${own}`, `${A} ${B} refs/heads/main`],
    [],
  ]) {
    assert.equal(decide(rejected).ok, false, rejected.join(' | '));
  }
});

test('a rejection is a report-status the client understands, framed for its sideband', () => {
  const framed = rejectionReport('refs/heads/main', 'no', ['side-band-64k']);
  const plain = rejectionReport('refs/heads/main', 'no', ['report-status']);

  assert.match(new TextDecoder().decode(plain), /^000eunpack ok\n001ang refs\/heads\/main no\n0000$/);
  assert.equal(new TextDecoder().decode(framed.subarray(4, 5)), '\u0001');
  assert.ok(new TextDecoder().decode(framed).endsWith('0000'));
  assert.deepEqual([...pktText('a').subarray(0, 4)], [...new TextEncoder().encode('0005')]);
});

test('capability tokens are hashed, expire after an hour and survive many rotations, up to a bound', async () => {
  const storage = memory();
  const first = newToken();
  await storeToken(storage, first);

  assert.equal(await tokenValid(storage, first), true);
  assert.equal(await tokenValid(storage, newToken()), false);
  assert.equal(JSON.stringify(await storage.get('gitAccess')).includes(first), false);

  const second = newToken();
  await storeToken(storage, second);
  assert.equal(await tokenValid(storage, first), true, 'a running Git command keeps working');
  assert.equal(await tokenValid(storage, second), true);
  assert.equal(await tokenExpiring(storage), false);

  const third = newToken();
  await storeToken(storage, third);
  assert.equal(await tokenValid(storage, first), true, 'a clone can outlive several rotations');

  const later = [];

  for (let rotation = 0; rotation < 20; rotation++) {
    later.push(newToken());
    await storeToken(storage, later[rotation] ?? '');
  }

  assert.equal(await tokenValid(storage, first), false, 'only the newest 16 are kept');
  assert.equal(await tokenValid(storage, later[3] ?? ''), false);
  assert.equal(await tokenValid(storage, later[4] ?? ''), true);
  assert.equal(await tokenValid(storage, later[19] ?? ''), true);

  const now = Date.now();
  mock.method(Date, 'now', () => now + 45 * 60 * 1000);
  assert.equal(await tokenExpiring(storage), true);
  mock.restoreAll();
  mock.method(Date, 'now', () => now + 61 * 60 * 1000);
  assert.equal(await tokenValid(storage, second), false);
  assert.equal(await tokenValid(storage, third), false);
  mock.restoreAll();
});

test('a token reaches only registered repos, whatever the base is', async () => {
  const storage = memory();
  const token = newToken();
  await storeToken(storage, token);
  await registerRepo(storage, 'https://github.com/octo/hello', 'hello', true);
  await registerRepo(storage, 'https://github.com/octo/second', 'second');
  await registerRepo(storage, 'https://gitlab.com/g/public', 'public');

  assert.equal(await gitAuthorization(storage, token, 'Octo', 'Second'), 'ok');
  assert.equal(await gitAuthorization(storage, token, 'octo', 'hello'), 'ok');
  assert.equal(await gitAuthorization(storage, token, 'octo', 'public'), 'forbidden');
  assert.equal(await gitAuthorization(storage, newToken(), 'octo', 'hello'), 'unauthorized');
});

test('the repo inventory keeps one base, refuses clashes and does not grant access by becoming base', async () => {
  const storage = memory();
  const one = 'https://github.com/octo/one';
  const two = 'https://github.com/octo/two';

  assert.equal((await registerRepo(storage, one, 'one')).repos[0]?.base, true);
  assert.equal((await registerRepo(storage, one, 'one')).added, false);
  await assert.rejects(registerRepo(storage, one, 'elsewhere'), /already checked out/);
  await assert.rejects(registerRepo(storage, two, 'one'), /already used/);
  await registerRepo(storage, two, 'two');
  await assert.rejects(setBaseRepo(storage, 'https://github.com/octo/never'), /not registered/);
  assert.deepEqual(
    (await setBaseRepo(storage, two)).map((repo) => repo.base),
    [false, true],
  );
  await unregisterRepo(storage, two);
  assert.equal((await readRepos(storage)).length, 1);
});

test('the sandbox git config rewrites github.com to the proxy and carries only the capability token', () => {
  const token = newToken();
  const config = gitConfig('https://worker.example', session, token);

  assert.match(
    config,
    new RegExp(`\\[url "https://worker.example/git/${session}/github.com/"\\]\\n\\tinsteadOf = https://github.com/`),
  );
  assert.match(config, new RegExp(`extraHeader = Authorization: Bearer ${token}`));
});

test('clone scripts quote every value and parse as valid shell', () => {
  const script = cloneScript({
    url: 'https://gitlab.com/g/it',
    path: 'repo',
    branch: 'feature/x',
    configPath: "/home/it's/.cloud-swe/git.config",
    identity: { login: 'o', name: "O'Brien $(touch pwned)", email: 'o@example.com' },
  });

  assert.match(script, /git clone --branch 'feature\/x' -- 'https:\/\/gitlab.com\/g\/it' 'repo'/);
  assert.match(script, /user.name 'O'\\''Brien \$\(touch pwned\)'/);
  execFileSync('bash', ['-n'], { input: script });
  assert.doesNotMatch(cloneScript({ url: 'https://gitlab.com/a/b', path: 'b', configPath: '/c' }), /user\.name/);
});

test('approval and message IDs derive deterministically from a name', async () => {
  const first = await deterministicUuid('approval:call-1');

  assert.equal(first, await deterministicUuid('approval:call-1'));
  assert.notEqual(first, await deterministicUuid('approval:call-2'));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('the sandbox-replaced notice fits its stored limit however many repositories there are', () => {
  const notice = sandboxReplacedNotice(
    Array.from({ length: 50 }, (_, index) => `https://github.com/o/${index}`.padEnd(120)),
  );

  assert.ok(notice.length <= 4000);
  assert.match(notice, /and \d+ more/);
});

const command = `${'a'.repeat(40)} ${'b'.repeat(40)} refs/heads/work`;

const commandList = concat([pkt(new TextEncoder().encode(command + '\0report-status')), FLUSH]);

const streamOf = (...chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

async function drain(stream: ReadableStream<Uint8Array>) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

test('a valid push whose first chunk is far larger than the command limit is read and replayed whole', async () => {
  const pack = new Uint8Array(MAX_COMMANDS_BYTES * 3).fill(7);
  const body = concat([commandList, pack, pack]);
  const { request, stream } = await readCommands(streamOf(concat([commandList, pack]), pack));

  assert.deepEqual(request.commands, [{ old: 'a'.repeat(40), new: 'b'.repeat(40), ref: 'refs/heads/work' }]);
  assert.deepEqual(await drain(stream), body);
});

test('a command list that stays incomplete past the limit is refused', async () => {
  const line = pkt(new TextEncoder().encode(command));
  const unfinished = concat(Array.from({ length: Math.ceil(MAX_COMMANDS_BYTES / line.length) + 1 }, () => line));

  await assert.rejects(readCommands(streamOf(unfinished)), /too large/);
  await assert.rejects(readCommands(streamOf(new TextEncoder().encode('00'))), /Truncated/);
});

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
