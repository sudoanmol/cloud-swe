/**
 * Path: protocol/test/git.test.ts
 * Used by: pnpm test.
 * Purpose: Contract tests for repository URLs, checkout paths, branches and the Git identity.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { AuthToken, GitIdentity } from '../src/credentials.ts';
import { BranchName, canonicalRepoUrl, defaultRepoPath, InitialRepo, RepoPath, RepoUrl } from '../src/git.ts';
import { CreateSessionRequest } from '../src/index.ts';

test('repository URLs are canonical https without credentials, ssh or odd hosts', () => {
  assert.equal(canonicalRepoUrl('https://github.com/Owner/Repo.git'), 'https://github.com/owner/repo');
  assert.equal(canonicalRepoUrl('https://github.com/owner/repo/'), 'https://github.com/owner/repo');
  assert.equal(canonicalRepoUrl('https://gitlab.com/group/sub/repo.git'), 'https://gitlab.com/group/sub/repo');

  for (const bad of [
    'git@github.com:owner/repo.git',
    'ssh://github.com/owner/repo',
    'http://github.com/owner/repo',
    'https://token@github.com/owner/repo',
    'https://user:pw@gitlab.com/a/b',
    'https://github.com/owner',
    'https://github.com/owner/repo/tree/main',
    'https://github.com/owner/repo?x=1',
    'https://github.com:444/owner/repo',
    'https://github.com/owner/..',
    'https://localhost/a/b',
    'https://127.0.0.1/a/b',
    'https://example.com/a b',
    'file:///etc/passwd',
  ])
    assert.equal(canonicalRepoUrl(bad), undefined, bad);

  assert.equal(RepoUrl.parse('https://github.com/A/B.git'), 'https://github.com/a/b');
});

test('the default checkout directory drops leading dots, and an initial repo needs a usable one', () => {
  assert.equal(defaultRepoPath('https://github.com/org/.github'), 'github');
  assert.equal(defaultRepoPath('https://github.com/org/repo'), 'repo');
  assert.equal(defaultRepoPath('https://example.com/~x'), undefined);
  assert.equal(defaultRepoPath('https://github.com/org/...'), undefined);

  assert.ok(InitialRepo.safeParse({ url: 'https://github.com/org/.github' }).success);
  assert.equal(InitialRepo.safeParse({ url: 'https://example.com/~x' }).success, false);
});

test('checkout paths and branches are single safe shell words', () => {
  for (const ok of ['repo', 'a/b', 'my-repo.v2']) assert.ok(RepoPath.safeParse(ok).success, ok);

  for (const bad of ['', '/abs', '../x', 'a/../b', '-rf', 'a b', 'a;b', '$(x)', 'a//b', '.hidden'])
    assert.equal(RepoPath.safeParse(bad).success, false, bad);

  for (const ok of ['main', 'feature/x-1', 'v1.2']) assert.ok(BranchName.safeParse(ok).success, ok);

  for (const bad of ['-x', 'a..b', 'a b', 'x.lock', 'a/', '$(x)', '--upload-pack=x'])
    assert.equal(BranchName.safeParse(bad).success, false, bad);
});

test('session creation accepts an optional repo', () => {
  const base = {
    operationId: crypto.randomUUID(),
    template: 'base',
    model: { provider: 'anthropic', id: 'm' },
  };

  assert.ok(CreateSessionRequest.safeParse(base).success);

  const withRepo = CreateSessionRequest.parse({ ...base, repo: { url: 'https://github.com/O/R.git', branch: 'main' } });
  assert.equal(withRepo.repo?.url, 'https://github.com/o/r');
  assert.equal(CreateSessionRequest.safeParse({ ...base, repo: { url: 'git@github.com:o/r.git' } }).success, false);
});

test('the auth token response and Git identity are strict', () => {
  assert.equal(AuthToken.safeParse({ token: '' }).success, false);
  const identity = { login: 'me', name: 'Me', email: '1+me@users.noreply.github.com' };
  assert.equal(GitIdentity.safeParse({ ...identity, token: 'x' }).success, false);
});
