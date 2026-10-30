import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';

import type { ToolCall } from '@earendil-works/pi-ai';

import { toolResults } from '../../protocol/test/provider-request.ts';
import { createSession, getSession, gitWorker, send, settled } from './git-env.ts';
import { FakeGitHub } from './github-fake.ts';

type Call = Pick<ToolCall, 'id' | 'name' | 'arguments'>;

test(
  'PR tools use the Worker-held PAT, stay registered-repo only and never open a duplicate PR or comment',
  {
    timeout: 120_000,
  },
  async () => {
    const fake = await FakeGitHub.create();
    await fake.repo('octo', 'hello');
    await fake.repo('octo', 'other');
    const calls: Call[][] = [];
    const bodies: string[] = [];
    const worker = await gitWorker(fake, 8793, calls, bodies);
    const { api } = worker;

    try {
      assert.equal((await api('/v1/credentials/github', 'PUT', { token: fake.pat })).status, 200);
      const created = await createSession(api, 'https://github.com/octo/hello');
      assert.ok(created.capabilities.tools.includes('github_pr_create'));
      assert.ok(created.capabilities.tools.includes('github_pr_merge'));
      assert.ok(created.capabilities.tools.includes('git_request_ref_update'));
      assert.ok(created.capabilities.tools.includes('git_clone'));
      assert.equal(created.capabilities.tools.includes('git_push'), false);

      const branch = `cloud-swe/add-feature-${created.id.slice(0, 8)}`;
      const pr = { head: branch, base: 'main', title: 'Add feature', body: 'Why' };
      // The first create reaches GitHub but its response is lost; the tool must find the PR instead of opening another.
      fake.lose.push({ pattern: /^POST \/repos\/octo\/hello\/pulls$/, used: false });

      // A comment whose call ID was already posted (a replay) is found, not posted again.
      fake.comments.push({ number: 1, body: 'earlier\n\n<!-- cloud-swe:call-comment-replay -->' });

      const rounds: Call[] = [
        { id: 'call-create', name: 'github_pr_create', arguments: pr },
        { id: 'call-create-again', name: 'github_pr_create', arguments: pr },
        { id: 'call-bad-head', name: 'github_pr_create', arguments: { ...pr, head: 'main' } },
        { id: 'call-update', name: 'github_pr_update', arguments: { number: 1, title: 'Renamed' } },
        { id: 'call-comment-replay', name: 'github_pr_comment', arguments: { number: 1, body: 'hi' } },
        { id: 'call-comment', name: 'github_pr_comment', arguments: { number: 1, body: 'hello' } },
        { id: 'call-list', name: 'github_pr_read', arguments: { view: 'list' } },
        { id: 'call-view', name: 'github_pr_read', arguments: { view: 'view', number: 1 } },
        { id: 'call-close', name: 'github_pr_close', arguments: { number: 1 } },
        { id: 'call-reopen', name: 'github_pr_reopen', arguments: { number: 1 } },
        { id: 'call-foreign', name: 'github_pr_create', arguments: { ...pr, repo: 'octo/other' } },
      ];

      for (const round of rounds) calls.push([round]);
      await send(api, created.id, 'Work on PRs');
      const done = await settled(api, created.id);
      assert.equal(done.run.kind, 'completed');

      const results = new Map(toolResults(bodies.at(-1) ?? '').map((result) => [result.callId, result]));
      const output = (id: string) => results.get(id)?.output ?? '';

      assert.match(output('call-create'), /^Opened #1 \[open\] Add feature/);
      assert.equal(fake.pulls.size, 1, 'one PR despite the lost response');
      assert.equal(fake.pulls.get(1)?.head, branch);
      assert.match(output('call-bad-head'), /head must be one of your branches/);
      assert.deepEqual(
        done.pullRequests.map(({ number, state, head }) => [number, state, head]),
        [[1, 'closed', branch]],
        'the session lists its own PR with its last known state',
      );
      assert.match(output('call-create-again'), /^Already open: #1/);
      assert.equal(fake.pulls.size, 1);
      assert.match(output('call-update'), /Renamed/);
      assert.match(output('call-comment-replay'), /^Commented:/);
      assert.equal(fake.comments.length, 2, 'the replayed comment was not posted again');
      assert.match(fake.comments.at(-1)?.body ?? '', /<!-- cloud-swe:call-comment -->$/);
      assert.match(output('call-list'), /#1 \[open\] Renamed/);
      assert.match(output('call-view'), /cloud-swe\/.* -> main/);
      assert.match(output('call-close'), /\[closed\]/);
      assert.match(output('call-reopen'), /\[open\]/);

      assert.equal(results.get('call-foreign')?.isError, true);
      assert.match(output('call-foreign'), /not registered/);
      assert.equal(fake.count(/octo\/other/), 0, 'an unregistered repo is never contacted');

      // The PAT never reaches the model, tool results or the session view.
      assert.equal(bodies.join('').includes(fake.pat), false);
      assert.equal(JSON.stringify(await getSession(api, created.id)).includes(fake.pat), false);
    } finally {
      await worker.mf.dispose();
      await rm(worker.storage, { recursive: true, force: true });
      await rm(fake.root, { recursive: true, force: true });
    }
  },
);
