import assert from 'node:assert/strict';
import test from 'node:test';

import { GitHubCredentialStatus, SetGitHubCredentialRequest, StoredGitHubCredential } from '../src/credentials.ts';
import { Approval, BranchName, canonicalRepoUrl, GitHubRepoRef, RepoPath, repoParts, RepoUrl } from '../src/git.ts';
import { CreateSessionRequest, Session } from '../src/index.ts';

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

  assert.deepEqual(repoParts('https://github.com/owner/repo'), { kind: 'github', owner: 'owner', repo: 'repo' });
  assert.deepEqual(repoParts('https://gitlab.com/a/b'), { kind: 'other' });
  assert.equal(RepoUrl.parse('https://github.com/A/B.git'), 'https://github.com/a/b');
  assert.equal(GitHubRepoRef.parse('A/B'), 'https://github.com/a/b');
  assert.equal(GitHubRepoRef.safeParse('https://gitlab.com/a/b').success, false);
});

test('checkout paths and branches are single safe shell words', () => {
  for (const ok of ['repo', 'a/b', 'my-repo.v2']) assert.ok(RepoPath.safeParse(ok).success, ok);

  for (const bad of ['', '/abs', '../x', 'a/../b', '-rf', 'a b', 'a;b', '$(x)', 'a//b', '.hidden'])
    assert.equal(RepoPath.safeParse(bad).success, false, bad);

  for (const ok of ['main', 'feature/x-1', 'v1.2']) assert.ok(BranchName.safeParse(ok).success, ok);

  for (const bad of ['-x', 'a..b', 'a b', 'x.lock', 'a/', '$(x)', '--upload-pack=x'])
    assert.equal(BranchName.safeParse(bad).success, false, bad);
});

test('session creation accepts an optional repo and sessions list repos and approvals', () => {
  const base = {
    operationId: crypto.randomUUID(),
    engine: 'pi',
    target: 'cloud',
    environment: 'base',
    model: { provider: 'anthropic', id: 'm' },
  };

  assert.ok(CreateSessionRequest.safeParse(base).success);

  const withRepo = CreateSessionRequest.parse({ ...base, repo: { url: 'https://github.com/O/R.git', branch: 'main' } });
  assert.equal(withRepo.repo?.url, 'https://github.com/o/r');
  assert.equal(CreateSessionRequest.safeParse({ ...base, repo: { url: 'git@github.com:o/r.git' } }).success, false);
  assert.equal(
    CreateSessionRequest.safeParse({ ...base, repo: { url: 'https://github.com/o/r', x: 1 } }).success,
    false,
  );
});

test('approvals carry a lease and reject unknown kinds and malformed shas', () => {
  const sha = 'a'.repeat(40);

  const common = {
    id: crypto.randomUUID(),
    repo: 'o/r',
    state: 'pending',
    createdAt: new Date().toISOString(),
  };

  const ref = Approval.parse({
    ...common,
    kind: 'ref_update',
    sha,
    targetBranch: 'main',
    force: false,
    expected: null,
  });

  assert.equal(ref.repo, 'https://github.com/o/r');
  assert.ok(Approval.safeParse({ ...common, kind: 'pr_merge', number: 3, method: 'squash', expected: sha }).success);
  assert.equal(Approval.safeParse({ ...common, kind: 'pr_merge', number: 3, method: 'rebase' }).success, false);
  assert.equal(
    Approval.safeParse({
      ...common,
      kind: 'ref_update',
      sha: 'short',
      targetBranch: 'main',
      force: false,
      expected: null,
    }).success,
    false,
  );
  assert.equal(Approval.safeParse({ ...common, kind: 'delete_repo' }).success, false);
  assert.equal(Session.shape.approvals.safeParse([ref, ref]).success, true);
});

test('GitHub PAT is write-only: status carries the login and never the token', () => {
  assert.deepEqual(SetGitHubCredentialRequest.parse({ token: '  ghp_x  ' }), { token: 'ghp_x' });
  assert.equal(SetGitHubCredentialRequest.safeParse({ token: ' ' }).success, false);
  assert.equal(GitHubCredentialStatus.safeParse({ configured: true, login: 'me', token: 'x' }).success, false);
  assert.equal(GitHubCredentialStatus.safeParse({ configured: true }).success, false);
  assert.ok(GitHubCredentialStatus.safeParse({ configured: false }).success);

  assert.ok(
    StoredGitHubCredential.safeParse({
      token: 't',
      identity: { login: 'me', name: 'Me', email: 'me@example.com' },
    }).success,
  );
});
