/**
 * Path: server/test/approvals.test.ts
 * Used by: pnpm test.
 * Purpose: Approvals are durable and non-blocking, and only the decision route executes them, once, under a lease.
 */

import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { Snapshot } from '@cloud-swe/protocol';
import { Approval } from '@cloud-swe/protocol/git';
import type { ToolCall } from '@earendil-works/pi-ai';

import { toolResults } from '../../protocol/test/provider-request.ts';
import { createSession, getSession, gitWorker, send, settled, until } from './git-env.ts';
import { FakeGitHub } from './github-fake.ts';

type Call = Pick<ToolCall, 'id' | 'name' | 'arguments'>;

test(
  'approvals are durable and non-blocking; only the decision route executes, once, with a lease',
  {
    timeout: 180_000,
  },
  async () => {
    const fake = await FakeGitHub.create();
    await fake.repo('octo', 'hello');
    await fake.repo('octo', 'other');
    const calls: Call[][] = [];
    const bodies: string[] = [];
    const worker = await gitWorker(fake, 8794, calls, bodies);
    const { api } = worker;

    try {
      const session = await createSession(api, 'https://github.com/octo/hello');
      const path = `/v1/sessions/${session.id}`;

      const decide = async (id: string, decision: 'approve' | 'reject') => {
        const response = await api(`${path}/approvals/${id}`, 'POST', { decision });

        return {
          status: response.status,
          approval: response.status === 200 ? Approval.parse(await response.json()) : undefined,
        };
      };

      // Files an approval through a scripted tool call and returns it from the session view.
      const request = async (call: Call) => {
        calls.push([call]);
        const before = (await getSession(api, session.id)).approvals.length;
        await send(api, session.id, 'Request ' + call.id);
        await settled(api, session.id);
        const current = (await getSession(api, session.id)).approvals;
        assert.equal(current.length, before + 1, call.id);
        const filed = current.at(-1);
        assert.ok(filed);

        return filed;
      };

      // The decided approval's result arrives as one follow-up that starts one new model request.
      const followUp = async (before: number, id: string, state: string) => {
        await until(async () => (bodies.length > before ? true : undefined), 'the follow-up request');
        await settled(api, session.id);
        assert.equal(bodies.length, before + 1, 'exactly one follow-up run');
        const text = new RegExp(`Approval ${id} to .* is ${state}`, 'g');
        assert.equal(bodies.at(-1)?.match(text)?.length, 1, 'the result appears once');
      };

      const quiet = async (before: number) => {
        await setTimeout(1000);
        assert.equal(bodies.length, before);
      };

      const tip = async (branch: string) => (await fake.sha('octo', 'hello', branch)) ?? '';

      // A. Approve a ref update: pending first, executed only by the route, delivered once.
      const main0 = await tip('main');
      const feature = await fake.advance('octo', 'hello', 'feature', 'a.txt', 'a\n');

      const a = await request({
        id: 'req-a',
        name: 'git_request_ref_update',
        arguments: { sha: feature, targetBranch: 'main' },
      });

      assert.equal(a.state, 'pending');
      assert.equal(a.kind === 'ref_update' && a.expected, main0);
      assert.equal(await tip('main'), main0, 'nothing is executed by the tool');
      assert.match(
        toolResults(bodies.at(-1) ?? '').find((result) => result.callId === 'req-a')?.output ?? '',
        /pending the user's decision/,
      );

      const snapshot = Snapshot.parse(await (await api(`${path}/snapshot`)).json());
      assert.deepEqual(
        snapshot.session.approvals.map((entry) => entry.id),
        [a.id],
      );

      let before = bodies.length;
      const approved = await decide(a.id, 'approve');
      assert.equal(approved.approval?.state, 'succeeded');
      assert.equal(await tip('main'), feature);
      await followUp(before, a.id, 'succeeded');

      before = bodies.length;
      assert.equal((await decide(a.id, 'approve')).approval?.state, 'succeeded', 'a repeat is idempotent');
      assert.equal((await decide(a.id, 'reject')).status, 409, 'the opposite decision conflicts');
      assert.equal(fake.count(/^PATCH .*refs\/heads\/main$/), 1, 'one dispatch');
      await quiet(before);

      // B. Reject: nothing executes, the agent is told once, approve now conflicts.
      const other = await fake.advance('octo', 'hello', 'other', 'b.txt', 'b\n');

      const b = await request({
        id: 'req-b',
        name: 'git_request_ref_update',
        arguments: { sha: other, targetBranch: 'main', force: true },
      });

      before = bodies.length;
      assert.equal((await decide(b.id, 'reject')).approval?.state, 'rejected');
      await followUp(before, b.id, 'rejected');
      assert.equal(await tip('main'), feature);
      assert.equal((await decide(b.id, 'approve')).status, 409);
      before = bodies.length;
      assert.equal((await decide(b.id, 'reject')).approval?.state, 'rejected');
      await quiet(before);

      // C. The lease: the target moved after the request, so approval fails and changes nothing.
      const c = await request({
        id: 'req-c',
        name: 'git_request_ref_update',
        arguments: { sha: other, targetBranch: 'main', force: true },
      });

      const moved = await fake.advance('octo', 'hello', 'main', 'c.txt', 'c\n');
      before = bodies.length;
      const failed = await decide(c.id, 'approve');
      assert.equal(failed.approval?.state, 'failed');
      assert.match(failed.approval?.result ?? '', /moved/);
      assert.equal(await tip('main'), moved);
      await followUp(before, c.id, 'failed');

      // D. A lost response after GitHub applied the update: unknown, then reconciled by reading, never re-sent.
      const next = await fake.advance('octo', 'hello', 'next', 'd.txt', 'd\n');

      const d = await request({
        id: 'req-d',
        name: 'git_request_ref_update',
        arguments: { sha: next, targetBranch: 'main' },
      });

      const patches = fake.count(/^PATCH .*refs\/heads\/main$/);
      fake.lose.push({ pattern: /^PATCH \/repos\/octo\/hello\/git\/refs\/heads\/main$/, used: false });
      before = bodies.length;
      const unknown = await decide(d.id, 'approve');
      assert.equal(unknown.approval?.state, 'unknown');
      assert.equal(await tip('main'), next, 'GitHub applied it');
      assert.equal((await getSession(api, session.id)).approvals.find((entry) => entry.id === d.id)?.state, 'unknown');
      await followUp(before, d.id, 'unknown');

      before = bodies.length;
      const reconciled = await decide(d.id, 'approve');
      assert.equal(reconciled.approval?.state, 'succeeded');
      assert.equal(fake.count(/^PATCH .*refs\/heads\/main$/), patches + 1, 'reconciled by reading, not re-sent');
      await followUp(before, d.id, 'succeeded');

      // E. Merge: the expected head is the lease and GitHub receives it as `sha`.
      const head = await tip('feature');
      fake.pulls.set(7, {
        number: 7,
        title: 'Feature',
        state: 'open',
        merged: false,
        head: 'feature',
        sha: head,
        base: 'main',
      });

      const e = await request({ id: 'req-e', name: 'github_pr_merge', arguments: { number: 7, method: 'squash' } });
      assert.equal(e.kind === 'pr_merge' && e.expected, head);
      assert.equal(fake.pulls.get(7)?.merged, false);
      before = bodies.length;
      assert.equal((await decide(e.id, 'approve')).approval?.state, 'succeeded');
      assert.equal(fake.pulls.get(7)?.merged, true);
      await followUp(before, e.id, 'succeeded');

      fake.pulls.set(8, {
        number: 8,
        title: 'Moved',
        state: 'open',
        merged: false,
        head: 'feature',
        sha: head,
        base: 'main',
      });
      const f = await request({ id: 'req-f', name: 'github_pr_merge', arguments: { number: 8 } });
      assert.equal(f.kind === 'pr_merge' && f.method, 'merge');

      const pull = fake.pulls.get(8);
      assert.ok(pull);
      pull.sha = 'c'.repeat(40);
      before = bodies.length;
      assert.equal((await decide(f.id, 'approve')).approval?.state, 'failed');
      assert.equal(pull.merged, false);
      await followUp(before, f.id, 'failed');

      // The base branch is leased too: retargeting the PR after the request fails the merge.
      fake.pulls.set(9, {
        number: 9,
        title: 'Retargeted',
        state: 'open',
        merged: false,
        head: 'feature',
        sha: head,
        base: 'main',
      });
      const g = await request({ id: 'req-g', name: 'github_pr_merge', arguments: { number: 9 } });
      assert.equal(g.kind === 'pr_merge' && g.baseRef, 'main');
      const retargeted = fake.pulls.get(9);
      assert.ok(retargeted);
      retargeted.base = 'release';
      before = bodies.length;
      const refused = await decide(g.id, 'approve');
      assert.equal(refused.approval?.state, 'failed');
      assert.match(refused.approval?.result ?? '', /base moved from main to release/);
      assert.equal(retargeted.merged, false);
      await followUp(before, g.id, 'failed');

      // A result the session refuses to admit is not lost: the delivery job sends it later, once, and runs nothing.
      const late = await fake.advance('octo', 'hello', 'late', 'h.txt', 'h\n');

      const h = await request({
        id: 'req-h',
        name: 'git_request_ref_update',
        arguments: { sha: late, targetBranch: 'main' },
      });

      assert.equal((await api('/v1/credentials/models/anthropic', 'DELETE')).status, 200);
      before = bodies.length;
      const delayed = await decide(h.id, 'approve');
      assert.equal(delayed.approval?.state, 'succeeded', 'the decision stands even though the agent could not be told');
      assert.equal(await tip('main'), late);
      await quiet(before);

      const dispatches = fake.count(/^(PATCH|POST|PUT) .*\/git\/refs/);
      assert.equal((await api('/v1/credentials/models/anthropic', 'PUT', { key: 'client-key' })).status, 200);
      await followUp(before, h.id, 'succeeded');
      await quiet(bodies.length);
      assert.equal(fake.count(/^(PATCH|POST|PUT) .*\/git\/refs/), dispatches, 'the job never touches GitHub');

      // Unknown approvals and malformed decisions are refused.
      assert.equal((await decide(crypto.randomUUID(), 'approve')).status, 404);
      assert.equal((await api(`${path}/approvals/${a.id}`, 'POST', { decision: 'maybe' })).status, 400);
      assert.equal((await fetch(new URL(`${path}/approvals/${a.id}`, worker.base), { method: 'POST' })).status, 401);
      assert.equal(bodies.join('').includes(fake.installationToken), false);
    } finally {
      await worker.mf.dispose();
      await rm(worker.storage, { recursive: true, force: true });
      await rm(fake.root, { recursive: true, force: true });
    }
  },
);
