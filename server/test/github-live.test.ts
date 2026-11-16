/**
 * Path: server/test/github-live.test.ts
 * Used by: pnpm test.
 * Purpose: Clones, pushes and opens a pull request on real GitHub through the Worker's proxy and tools, on the scratch repository; runs only with pnpm test --github, and removes what it creates. With --e2b too, the sandbox is a real E2B one that reaches the Worker through a quick tunnel.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { Sandbox } from 'e2b';
import { z } from 'zod';

import { branchSuffix } from '../src/git/push.ts';
import { githubJson, GitHubPull, mintRepoToken, readPullRequest, readRef, writeRef } from '../src/github.ts';
import { createSession, getSession, gitWorker, send } from './git-env.ts';
import { toolResults } from './provider-request.ts';
import { type Call, runEnded, waitFor } from './rig.ts';
import { forwardOutbound } from './runtime.ts';

// Public, owned by the project's owner and set aside for this; the App is installed with contents and pull requests write.
const OWNER = 'sudoanmol';
const REPO = 'cloud-swe-e2e';
const SLUG = `${OWNER}/${REPO}`;

const PORT = 8806;

const live = process.env.GITHUB_BACKEND === 'github';

// With --e2b the sandbox is a real E2B one, billed, and it reaches this container's Worker through a quick tunnel.
const cloud = process.env.WORKSPACE_BACKEND === 'e2b';
const e2bKey = process.env.E2B_API_KEY;

const Person = z.object({ name: z.string(), email: z.string() });

const Commit = z.object({
  author: z.object({ login: z.string() }).nullable(),
  commit: z.object({ author: Person, committer: Person, message: z.string() }),
});

const branches = async (token: string) =>
  (await githubJson(z.array(z.object({ name: z.string() })), token, 'GET', `/repos/${SLUG}/branches?per_page=100`)).map(
    (branch) => branch.name,
  );

const openPulls = (token: string) =>
  githubJson(z.array(GitHubPull), token, 'GET', `/repos/${SLUG}/pulls?state=open&per_page=100`);

/**
 * A cloudflared quick tunnel to the Worker: no account, a new trycloudflare.com hostname each run, no uptime guarantee.
 * It runs inside the test container, so it ends with it at the latest.
 */
async function quickTunnel() {
  const metrics = 'http://127.0.0.1:20241';

  const child = spawn(
    'cloudflared',
    ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`, '--metrics', metrics.slice('http://'.length)],
    { stdio: 'ignore' },
  );

  try {
    // /ready answers 200 once a connection to Cloudflare's edge is registered.
    await waitFor(
      () =>
        fetch(metrics + '/ready').then(
          (response) => response.ok,
          () => false,
        ),
      Boolean,
      60_000,
    );

    const { hostname } = z
      .object({ hostname: z.string().min(1) })
      .parse(await (await fetch(metrics + '/quicktunnel')).json());

    return { url: `https://${hostname}`, close: () => child.kill() };
  } catch (error) {
    child.kill();
    throw error;
  }
}

/**
 * Waits until Cloudflare's edge routes the new hostname to the Worker, which answers an unsigned request with 401, and
 * returns the seconds it took. A clone sent before that gets the edge's error, and the creation clone is not retried.
 */
async function routed(url: string) {
  for (let seconds = 0; seconds < 60; seconds++) {
    if (
      (await fetch(`${url}/v1/sessions`).then(
        (response) => response.status,
        () => 0,
      )) === 401
    )
      return seconds;
    await setTimeout(1000);
  }

  throw new Error('The quick tunnel never reached the Worker');
}

/** Kills the E2B sandboxes of an app workspace, found by the metadata the server gives them. */
async function killSandboxes(workspaceId: string) {
  const found = await Sandbox.list({
    apiKey: e2bKey,
    query: { metadata: { cloudSweWorkspace: workspaceId } },
  }).nextItems();

  for (const sandbox of found) await Sandbox.kill(sandbox.sandboxId, { apiKey: e2bKey });
}

/** Closes every open pull request from this run's branches, then deletes the branches. */
async function cleanUp(token: string, suffix: string) {
  const ours = (name: string) => name.endsWith(`-${suffix}`);

  for (const pull of await openPulls(token)) {
    if (ours(pull.head.ref)) {
      await githubJson(GitHubPull, token, 'PATCH', `/repos/${SLUG}/pulls/${pull.number}`, { state: 'closed' });
    }
  }

  for (const name of await branches(token)) {
    if (ours(name)) await writeRef(token, SLUG, `refs/heads/${name}`, null, null);
  }
}

test(
  'the Worker clones, pushes and opens a pull request on real GitHub',
  { skip: !live, timeout: 600_000 },
  async (t) => {
    const key = process.env.GITHUB_APP_PRIVATE_KEY ?? '';
    // The key spans many lines; parsing it proves it reached the container whole.
    assert.equal(createPrivateKey(key).asymmetricKeyType, 'rsa');
    const app = { GITHUB_APP_CLIENT_ID: process.env.GITHUB_APP_CLIENT_ID ?? '', GITHUB_APP_PRIVATE_KEY: key };
    // The test reads GitHub with its own installation token, minted the way the Worker mints one.
    const minted = await mintRepoToken(app, OWNER, REPO);
    assert.ok(minted, 'the GitHub App is installed on the scratch repository');
    const { token } = minted;
    const startBranches = await branches(token);
    const main = await readRef(token, SLUG, 'refs/heads/main');
    const calls: Call[][] = [];
    const bodies: string[] = [];
    let tunnel: Awaited<ReturnType<typeof quickTunnel>> | undefined;
    let worker: Awaited<ReturnType<typeof gitWorker>> | undefined;
    let workspace: string | undefined;
    let suffix: string | undefined;

    try {
      tunnel = cloud ? await quickTunnel() : undefined;

      const template = tunnel ? 'cloud-swe' : 'base';

      const settings: Record<string, string> = tunnel
        ? { WORKSPACE_BACKEND: 'e2b', WORKSPACE_TEMPLATES: template, PUBLIC_URL: tunnel.url }
        : {};

      worker = await gitWorker({ appSettings: app, handle: forwardOutbound }, PORT, calls, bodies, settings);
      const { api } = worker;

      if (tunnel) t.diagnostic(`the tunnel reached the Worker after ${await routed(tunnel.url)} s`);
      const session = await createSession(api, `https://github.com/${SLUG}`, template);
      workspace = session.workspace.id;
      suffix = branchSuffix(session.id);
      const branch = `cloud-swe/live-test-${suffix}`;

      /** Runs one tool call as the scripted agent and returns its result. */
      const agent = async (name: string, args: Call['arguments']) => {
        const call = { id: crypto.randomUUID(), name, arguments: args };
        calls.push([call]);
        await send(api, session.id, 'Run ' + name);
        const done = await waitFor(() => getSession(api, session.id), runEnded, 180_000);
        assert.equal(done.run.kind, 'completed');
        const result = toolResults(bodies.at(-1) ?? '').find((entry) => entry.callId === call.id);
        assert.ok(result, 'the tool answered');

        return result;
      };

      const bash = (command: string) => agent('bash', { command });
      const branchTip = () => readRef(token, SLUG, `refs/heads/${branch}`);
      let tip = '';

      await t.test('a session created with the repository clones it through the proxy', async () => {
        const head = await bash(
          // On a timeout, ls-remote shows whether the proxy answers at all.
          `(timeout 90 sh -c 'until [ -f ${REPO}/README.md ]; do sleep 1; done' || { git ls-remote https://github.com/${SLUG} HEAD; exit 1; }) && git -C ${REPO} rev-parse HEAD`,
        );

        assert.equal(head.isError, false, head.output);
        assert.equal(/[0-9a-f]{40}/.exec(head.output)?.[0], main);
      });

      await t.test('the agent commits and pushes its session branch, authored by the bot', async () => {
        const pushed = await bash(
          `cd ${REPO} && git checkout -q -b work && echo ${suffix} > live-${suffix}.txt && git add . && git commit -qm "Live test ${suffix}" && git push -q origin HEAD:${branch} && git rev-parse HEAD`,
        );

        assert.equal(pushed.isError, false, pushed.output);
        tip = /[0-9a-f]{40}/.exec(pushed.output)?.[0] ?? '';
        assert.equal(await branchTip(), tip);

        const { author, commit } = await githubJson(Commit, token, 'GET', `/repos/${SLUG}/commits/${tip}`);
        const bot = { name: 'cloud-swe[bot]', email: '332717987+cloud-swe[bot]@users.noreply.github.com' };
        assert.deepEqual(commit.author, bot);
        assert.deepEqual(commit.committer, bot);
        assert.equal(author?.login, 'cloud-swe[bot]', 'GitHub links the commit to the bot account');

        // The Docker double mounts the workspace noexec, so Git skips the hook there; E2B runs it.
        if (cloud) assert.match(commit.message, /\n\nCo-authored-by: Octo Cat <42\+octo@users\.noreply\.github\.com>$/);
      });

      await t.test(
        'pushes the policy forbids are refused, a blocked one waits for approval, and main stays',
        async () => {
          const toMain = await bash(`cd ${REPO} && git push origin HEAD:main`);
          assert.equal(toMain.isError, true);
          assert.match(toMain.output, /only cloud-swe\/<slug>-/);

          const forced = await bash(
            `cd ${REPO} && git commit -q --amend -m "Forced ${suffix}" && git push --force origin HEAD:${branch}`,
          );

          assert.equal(forced.isError, true);
          assert.match(forced.output, /force push requires approval/);
          assert.equal(await branchTip(), tip, 'the forced update was reverted on GitHub');

          const deleted = await bash(`cd ${REPO} && git push origin :${branch}`);
          assert.match(deleted.output, /sent to the user/);

          const requested = await agent('git_request_ref_update', { sha: tip, targetBranch: 'main' });
          assert.match(requested.output, /pending the user's decision/);

          const { approvals } = await getSession(api, session.id);

          assert.deepEqual(
            approvals.map((approval) => [approval.kind, approval.state]),
            [
              ['ref_change', 'pending'],
              ['ref_update', 'pending'],
            ],
          );

          assert.equal(await branchTip(), tip);
          assert.equal(await readRef(token, SLUG, 'refs/heads/main'), main);
        },
      );

      await t.test('the PR tool opens a draft pull request for the session branch', async () => {
        const opened = await agent('github_pr_create', {
          head: branch,
          base: 'main',
          title: `Live test ${suffix} (safe to close)`,
          body: 'Opened by pnpm test --github, which closes it.',
          draft: true,
        });

        assert.equal(opened.isError, false, opened.output);
        const pull = await readPullRequest(token, SLUG, Number(/#(\d+)/.exec(opened.output)?.[1]));
        assert.equal(pull.state, 'open');
        assert.equal(pull.draft, true);
        assert.equal(pull.head.ref, branch);
        assert.equal(pull.head.sha, tip);
        assert.equal(pull.base.ref, 'main');

        const { pullRequests } = await getSession(api, session.id);
        assert.deepEqual(
          pullRequests.map(({ number, head }) => [number, head]),
          [[pull.number, branch]],
        );
      });

      if (tunnel) {
        const { url } = tunnel;

        await t.test("through the tunnel, a request without this run's random token is refused", async () => {
          // The token the rig used before it became random, which this repository still shows.
          for (const authorization of [undefined, 'Bearer integration-test-personal-token']) {
            const response = await fetch(`${url}/v1/sessions`, { headers: authorization ? { authorization } : {} });
            assert.equal(response.status, 401);
          }
        });
      }
    } finally {
      await worker?.close();
      tunnel?.close();

      if (cloud && workspace) await killSandboxes(workspace);

      if (suffix) await cleanUp(token, suffix);
    }

    assert.deepEqual(await branches(token), startBranches, 'every branch this run created is gone');
    assert.deepEqual(
      (await openPulls(token)).filter((pull) => pull.head.ref.endsWith(`-${suffix}`)),
      [],
      'no pull request from this run is open',
    );
    assert.equal(await readRef(token, SLUG, 'refs/heads/main'), main);
  },
);
