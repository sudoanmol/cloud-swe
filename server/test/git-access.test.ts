/**
 * Path: server/test/git-access.test.ts
 * Used by: pnpm test.
 * Purpose: Capability tokens, the repo inventory, the sandbox git config, clone scripts and commit identity, without a running Worker.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

import { gitConfig, storeToken, tokenExpiring, tokenValid } from '../src/git/access.ts';
import { cloneScript } from '../src/git/clone.ts';
import { readRepos, registerRepo, setBaseRepo, unregisterRepo } from '../src/git/repos.ts';
import { deterministicUuid, randomToken as newToken } from '../src/ids.ts';
import { sandboxReplacedNotice } from '../src/sessions/notice.ts';
import { memoryStorage } from './fakes.ts';

const session = crypto.randomUUID();

test('capability tokens are hashed, expire after an hour and survive many rotations, up to a bound', async () => {
  const storage = memoryStorage();
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

test('the repo inventory keeps one base and refuses clashes', async () => {
  const storage = memoryStorage();
  const one = 'https://github.com/octo/one';
  const two = 'https://github.com/octo/two';

  assert.equal(await registerRepo(storage, one, 'one'), true);
  assert.equal((await readRepos(storage))[0]?.base, true);
  assert.equal(await registerRepo(storage, one, 'one'), false);
  await assert.rejects(registerRepo(storage, one, 'elsewhere'), /already checked out/);
  await assert.rejects(registerRepo(storage, two, 'one'), /already used/);
  await registerRepo(storage, two, 'two');
  await assert.rejects(setBaseRepo(storage, 'https://github.com/octo/never'), /not registered/);
  await setBaseRepo(storage, two);
  assert.deepEqual(
    (await readRepos(storage)).map((repo) => repo.base),
    [false, true],
  );
  await unregisterRepo(storage, two);
  assert.equal((await readRepos(storage)).length, 1);
});

test('the sandbox git config holds a remote helper for the proxy and only the capability token', () => {
  const token = newToken();
  const config = gitConfig('https://worker.example', session, token);
  // Git reads the helper back as a shell alias that sends a remote's URL to this session's proxy.
  const helper = execFileSync('git', ['config', '-f', '-', '--get', 'alias.remote-cloud-swe'], { input: config });

  assert.equal(
    helper.toString(),
    `!f() { exec git remote-https "$1" "https://worker.example/git/${session}/\${2#https://}"; }; f\n`,
  );
  assert.equal(config.includes('insteadOf'), false, 'a URL rewrite would hide github.com from gh');
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

  // Another host is cloned directly; only a GitHub checkout names the proxy's remote helper.
  assert.match(script, /git clone --branch 'feature\/x' -- 'https:\/\/gitlab.com\/g\/it' 'repo'/);
  assert.equal(script.includes('remote.origin.vcs'), false);
  execFileSync('bash', ['-n'], { input: script });

  const github = cloneScript({
    url: 'https://github.com/octo/hello',
    path: 'hello',
    configPath: '/home/user/git.config',
  });

  assert.match(github, /git clone -c remote\.origin\.vcs=cloud-swe -- 'https:\/\/github.com\/octo\/hello' 'hello'/);
  assert.match(github, /git -C 'hello' config remote\.origin\.vcs cloud-swe/);
  execFileSync('bash', ['-n'], { input: github });
});

test('commits are authored by the bot and credit the signed-in account on every kind of commit', async () => {
  const home = await mkdtemp(join(tmpdir(), 'clone-identity-'));
  const env = { ...process.env, HOME: home };
  const run = (command: string) => execFileSync('bash', ['-c', command], { cwd: home, env, encoding: 'utf8' });

  try {
    run(
      'git init -q --initial-branch=main up && git -C up -c user.name=a -c user.email=a@b commit -q --allow-empty -m start',
    );
    run(
      cloneScript({
        url: join(home, 'up'),
        path: 'repo',
        configPath: join(home, 'git.config'),
        identity: { login: 'o', name: "O'Brien $(touch pwned)", email: '1+o@users.noreply.github.com' },
      }),
    );

    const credit = "Co-authored-by: O'Brien $(touch pwned) <1+o@users.noreply.github.com>";

    run('git -C repo commit -q --allow-empty -m one');
    assert.equal(
      run('git -C repo log -1 --format=%an%n%ae%n%cn'),
      'cloud-swe[bot]\n332717987+cloud-swe[bot]@users.noreply.github.com\ncloud-swe[bot]\n',
    );
    assert.equal(run('git -C repo log -1 --format=%B').trim(), `one\n\n${credit}`);

    // Skipping hooks doesn't drop it, and amending doesn't repeat it.
    run(
      'git -C repo commit -q --allow-empty --no-verify -m two && git -C repo commit -q --amend --allow-empty --no-edit',
    );
    assert.equal(run('git -C repo log -1 --format=%B').trim(), `two\n\n${credit}`);
    assert.equal(run('ls -a').includes('pwned'), false);

    // A repo that moves core.hooksPath, as husky does, keeps the credit through the config-defined hook (Git 2.54+).
    const [major = 0, minor = 0] = (/(\d+)\.(\d+)/.exec(run('git --version')) ?? []).slice(1).map(Number);

    if (major > 2 || (major === 2 && minor >= 54)) {
      run('mkdir -p repo/.husky/_ && git -C repo config core.hooksPath .husky/_');
      run('git -C repo commit -q --allow-empty -m husky');
      assert.equal(run('git -C repo log -1 --format=%B').trim(), `husky\n\n${credit}`);
    }

    // Without a sign-in the bot is still the author, and nobody is credited.
    run(
      `${cloneScript({ url: join(home, 'up'), path: 'bare', configPath: join(home, 'git.config') })}\ngit -C bare commit -q --allow-empty -m three`,
    );
    assert.equal(run('git -C bare log -1 --format=%an%n%B').trim(), 'cloud-swe[bot]\nthree');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('message IDs derive deterministically from a name', async () => {
  const first = await deterministicUuid('question:call-1');

  assert.equal(first, await deterministicUuid('question:call-1'));
  assert.notEqual(first, await deterministicUuid('question:call-2'));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('the sandbox-replaced notice fits its stored limit however many repositories there are', () => {
  const notice = sandboxReplacedNotice(
    Array.from({ length: 50 }, (_, index) => `https://github.com/o/${index}`.padEnd(120)),
  );

  assert.ok(notice.length <= 4000);
  assert.match(notice, /and \d+ more/);
});
