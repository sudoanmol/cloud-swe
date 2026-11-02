// The Git half of run.mjs, which needs a deployed Worker: the sandbox has to reach the proxy.
// Writes to sudoanmol/bubbles (a throwaway repo): one session branch, scratch branches and PRs, all removed or closed.

import assert from 'node:assert/strict';

const REPO = 'sudoanmol/bubbles';
const PRIVATE = 'sudoanmol/CSE434_Socket_Project';

export async function gitStages({ Conversation, stage, gh, post, until, sleep, scanForCredentials }) {
  const scratch = `e2e-${Date.now()}`;
  const mainSha = () => gh('api', `repos/${REPO}/git/ref/heads/main`, '--jq', '.object.sha');
  const before = mainSha();
  const git = await Conversation.start();
  let branch, sha, pr;

  const approval = (kind, match) =>
    until(`a ${kind} approval`, 90, async () => {
      const { session } = await git.snapshot();

      return session.approvals.find((item) => item.kind === kind && item.state === 'pending' && match(item));
    }, 2000);

  const decided = (id) =>
    until('the approval to finish', 90, async () => {
      const { session } = await git.snapshot();
      const item = session.approvals.find((candidate) => candidate.id === id);

      return !['pending', 'executing'].includes(item.state) && item;
    }, 2000);

  const decide = (id, decision) => post(git.path(`/approvals/${id}`), { decision });

  await stage('git-clone-public', async () => {
    const { tools, snapshot } = await git.ask(`Use the git_clone tool on https://github.com/${REPO}, then reply "done".`);
    const call = tools.find((tool) => tool.name === 'git_clone');

    assert.ok(call, tools.map((tool) => tool.name).join());
    assert.equal(call.outcome.kind, 'succeeded', JSON.stringify(call.outcome).slice(0, 1200));
    assert.ok(snapshot.session.repos.some((repo) => repo.url.endsWith(REPO) && repo.base));
  });

  await stage('git-no-token-in-sandbox', async () => {
    await scanForCredentials(git.sandboxId);
    const output = await git.bash('git -C bubbles remote get-url origin | sed -E "s#/git/[^/]+/#/git/ID/#"');

    assert.match(output, /\/git\/ID\/github\.com\/sudoanmol\/bubbles/, 'Git goes through the proxy');
  });

  await stage('git-push-session-branch', async () => {
    const { tools } = await git.ask(
      `In bubbles, create a new branch following your session branch rule (cloud-swe/<slug>-<id>), add a file e2e-${scratch}.txt, ` +
        'commit it, and push the branch with plain git push. Then use bash to print `git branch --show-current` and `git rev-parse HEAD`. Reply "done".',
      6,
    );
    const output = tools.filter((tool) => tool.name === 'bash').map((tool) => tool.outcome.output ?? '').join('\n');

    branch = /cloud-swe\/\S+/.exec(output.split('\n').reverse().join('\n'))?.[0];
    sha = /\b[0-9a-f]{40}\b/.exec(output)?.[0];
    assert.ok(branch && sha, output.slice(-800));
    assert.equal(gh('api', `repos/${REPO}/git/ref/heads/${branch}`, '--jq', '.object.sha'), sha);

    const author = gh('api', `repos/${REPO}/commits/${sha}`, '--jq', '.commit.author.email');

    assert.match(author, /users\.noreply\.github\.com$/);

    return branch;
  });

  await stage('git-refused-pushes', async () => {
    const output = await git.bash(
      `cd bubbles; git push origin HEAD:main 2>&1 | tail -2; echo "main=$?"; git push origin HEAD:refs/heads/not-mine-${scratch} 2>&1 | tail -2; ` +
        `git push origin --delete ${branch} 2>&1 | tail -2; git tag t-${scratch}; git push origin t-${scratch} 2>&1 | tail -2; echo tried-all`,
    );

    assert.match(output, /tried-all/);
    assert.equal(mainSha(), before, 'main did not move');
    assert.equal(gh('api', `repos/${REPO}/git/ref/heads/${branch}`, '--jq', '.object.sha'), sha, 'the session branch survived the delete');

    for (const ref of [`heads/not-mine-${scratch}`, `tags/t-${scratch}`]) {
      assert.equal(gh('api', `repos/${REPO}/git/matching-refs/${ref}`, '--jq', 'length'), '0', `${ref} was created`);
    }
  });

  await stage('github-pr-tools', async () => {
    const { tools, snapshot } = await git.ask(
      `Use these tools in order on ${REPO}: github_pr_create a draft from ${branch} into main titled "E2E test (safe to close)"; ` +
        'github_pr_comment on it with "e2e comment"; github_pr_update its title to "E2E test updated (safe to close)"; ' +
        'github_pr_read it; github_pr_close it; github_pr_reopen it. Reply "done".',
      6,
    );

    for (const name of ['create', 'comment', 'update', 'read', 'close', 'reopen']) {
      const call = tools.find((tool) => tool.name === `github_pr_${name}`);

      assert.ok(call, `no ${name}: ${tools.map((tool) => tool.name)}`);
      assert.equal(call.outcome.kind, 'succeeded', JSON.stringify(call.outcome).slice(0, 800));
    }

    pr = snapshot.session.pullRequests.at(-1);
    assert.equal(pr.state, 'open');
    const real = JSON.parse(gh('pr', 'view', String(pr.number), '-R', REPO, '--json', 'title,isDraft,state,comments'));

    assert.match(real.title, /updated/);
    assert.equal(real.isDraft, true);
    assert.equal(real.state, 'OPEN');
    assert.ok(real.comments.some((comment) => comment.body.includes('e2e comment')));

    return pr.url;
  });

  await stage('approval-reject', async () => {
    await git.send(`Use git_request_ref_update on ${REPO} with sha ${sha} and targetBranch reject-${scratch}, then reply "filed".`);
    const filed = await approval('ref_update', (item) => item.targetBranch === `reject-${scratch}`);

    await git.settled();
    await decide(filed.id, 'reject');
    assert.equal((await decided(filed.id)).state, 'rejected');
    git.fresh(await git.settled());
    assert.equal(gh('api', `repos/${REPO}/git/matching-refs/heads/reject-${scratch}`, '--jq', 'length'), '0');
  });

  await stage('approval-allow-ref-update', async () => {
    await git.send(`Use git_request_ref_update on ${REPO} with sha ${sha} and targetBranch base-${scratch}, then reply "filed".`);
    const filed = await approval('ref_update', (item) => item.targetBranch === `base-${scratch}`);

    await git.settled();
    await decide(filed.id, 'approve');
    const done = await decided(filed.id);

    assert.equal(done.state, 'succeeded', done.result);
    assert.equal(gh('api', `repos/${REPO}/git/ref/heads/base-${scratch}`, '--jq', '.object.sha'), sha);
    git.fresh(await git.settled());
  });

  await stage('approval-allow-merge', async () => {
    // The merge lands on a scratch base branch made from main, never on main.
    gh('api', `repos/${REPO}/git/refs`, '-f', `ref=refs/heads/target-${scratch}`, '-f', `sha=${before}`);
    const { snapshot } = await git.ask(
      `Use github_pr_update on PR #${pr.number} of ${REPO} to set its base to target-${scratch}. Reply "done".`,
    );

    assert.equal(snapshot.session.run.kind, 'completed');
    gh('pr', 'ready', String(pr.number), '-R', REPO);
    await git.send(`Use github_pr_merge on PR #${pr.number} of ${REPO}, then reply "filed".`);
    const filed = await approval('pr_merge', (item) => item.number === pr.number);

    await git.settled();
    await decide(filed.id, 'approve');
    const done = await decided(filed.id);

    assert.equal(done.state, 'succeeded', done.result);
    assert.equal(JSON.parse(gh('pr', 'view', String(pr.number), '-R', REPO, '--json', 'state')).state, 'MERGED');
    assert.equal(mainSha(), before, 'main did not move');
    git.fresh(await git.settled());
  });

  await stage('git-clone-private', async () => {
    const { tools } = await git.ask(
      `Use git_clone on https://github.com/${PRIVATE}, then use bash to run: git -C cse434_socket_project log -1 --format=%H (the clone uses a lowercase directory). Reply "done".`,
      5,
    );

    assert.equal(tools.find((tool) => tool.name === 'git_clone')?.outcome.kind, 'succeeded');
    const head = tools.find((tool) => tool.name === 'bash').outcome.output.trim();

    assert.equal(head, gh('api', `repos/${PRIVATE}/commits/HEAD`, '--jq', '.sha'));
  });

  await stage('session-created-with-repo', async () => {
    const withRepo = await Conversation.start({ repo: { url: `https://github.com/${REPO}` } });

    await sleep(20_000);
    const output = await withRepo.bash('git -C bubbles log -1 --format=%H');

    assert.equal(output.trim(), mainSha());
  });

  for (const ref of [`heads/base-${scratch}`, `heads/target-${scratch}`, `heads/${branch}`]) {
    try {
      gh('api', '-X', 'DELETE', `repos/${REPO}/git/refs/${ref}`);
    } catch {
      console.log(`cleanup: could not delete ${ref}`);
    }
  }
}
