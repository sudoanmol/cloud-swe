/**
 * Path: server/test/github-live.test.ts
 * Used by: pnpm test.
 * Purpose: Clones and pushes on real GitHub through the Worker's proxy, then opens, comments on and merges a pull request with `gh`, on the scratch repository; runs only with pnpm test --github, and removes what it creates. With --e2b too, the sandbox is a real E2B one that reaches the Worker through a quick tunnel.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { Sandbox } from 'e2b';
import { z } from 'zod';

import { branchSuffix } from '../src/git/repos.ts';
import { appInstallations, github, GitHubError, githubJson, mintInstallationToken } from '../src/github.ts';
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

const Ref = z.object({ object: z.object({ sha: z.string() }) });

const Pull = z.object({
  number: z.number(),
  user: z.object({ login: z.string() }),
  base: z.object({ ref: z.string() }),
  merged_at: z.string().nullable(),
});

const Comment = z.object({ body: z.string(), user: z.object({ login: z.string() }) });

/** The commit a branch points at, or null when it does not exist. */
async function readBranch(token: string, name: string) {
  try {
    return (await githubJson(Ref, token, 'GET', `/repos/${SLUG}/git/ref/heads/${name}`)).object.sha;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return null;

    throw error;
  }
}

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
  // A lookup made before Cloudflare publishes the hostname is remembered as "no such name" by this machine's resolvers
  // for over a minute (measured 75 s; the record exists after 3), so ask over HTTPS, which caches nothing here.
  await waitFor(
    () =>
      fetch(`https://cloudflare-dns.com/dns-query?type=A&name=${new URL(url).hostname}`, {
        headers: { accept: 'application/dns-json' },
      })
        .then((response) => response.json())
        .then(
          (answer) => z.object({ Answer: z.array(z.unknown()).min(1) }).safeParse(answer).success,
          () => false,
        ),
    Boolean,
    60_000,
  );

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

/** Deletes this run's branches, which also closes a pull request still open from one. */
async function cleanUp(token: string, suffix: string) {
  for (const name of await branches(token)) {
    if (name.endsWith(`-${suffix}`)) await github(token, 'DELETE', `/repos/${SLUG}/git/refs/heads/${name}`);
  }
}

test('the agent clones, pushes and uses gh on real GitHub', { skip: !live, timeout: 600_000 }, async (t) => {
  const key = process.env.GITHUB_APP_PRIVATE_KEY ?? '';
  // The key spans many lines; parsing it proves it reached the container whole.
  assert.equal(createPrivateKey(key).asymmetricKeyType, 'rsa');
  const app = { GITHUB_APP_CLIENT_ID: process.env.GITHUB_APP_CLIENT_ID ?? '', GITHUB_APP_PRIVATE_KEY: key };
  // The test reads GitHub with its own installation token, minted the way the Worker mints one.
  const installation = (await appInstallations(app)).get(OWNER);
  assert.ok(installation, "the GitHub App is installed on the scratch repository's account");
  const { token } = await mintInstallationToken(app, installation);
  const startBranches = await branches(token);
  const main = await readBranch(token, 'main');
  const calls: Call[][] = [];
  const bodies: string[] = [];
  let tunnel: Awaited<ReturnType<typeof quickTunnel>> | undefined;
  let worker: Awaited<ReturnType<typeof gitWorker>> | undefined;
  let workspace: string | undefined;
  let suffix: string | undefined;

  try {
    tunnel = cloud ? await quickTunnel() : undefined;

    const template = tunnel ? 'cloud-swe' : 'base';

    // `gh` needs the egress daemon, which the plain Docker double can't run.
    const settings: Record<string, string> = tunnel
      ? { WORKSPACE_BACKEND: 'e2b', WORKSPACE_TEMPLATES: template, PUBLIC_URL: tunnel.url }
      : { DOCKER_SANDBOX_URL: process.env.GITHUB_SANDBOX_URL ?? '', DOCKER_SANDBOX_ROOT: '1' };

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
    const branchTip = () => readBranch(token, branch);

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
      const tip = /[0-9a-f]{40}/.exec(pushed.output)?.[0] ?? '';
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
      'gh opens a pull request as the bot, comments on it and merges it, with nobody approving',
      async () => {
        // Merged into a branch of this run's own, so the scratch repository's main never moves.
        const base = `cloud-swe/live-base-${suffix}`;

        const merged = await bash(
          [
            `cd ${REPO} && git push -q origin origin/main:refs/heads/${base}`,
            `gh pr create --head ${branch} --base ${base} --title "Live test ${suffix}" --body "Opened by the live test."`,
            `gh pr comment ${branch} --body "Comment ${suffix}"`,
            // GitHub works out whether a new pull request can merge a moment after it opens.
            `for attempt in 1 2 3 4 5 6; do gh pr merge ${branch} --merge && break; sleep 5; done`,
            `gh pr view ${branch} --json state --jq .state`,
          ].join(' && '),
        );

        assert.equal(merged.isError, false, merged.output);
        assert.match(merged.output, /MERGED\s*$/);

        const [pull] = await githubJson(
          z.array(Pull),
          token,
          'GET',
          `/repos/${SLUG}/pulls?state=all&head=${OWNER}:${branch}`,
        );

        assert.ok(pull, 'the pull request exists');
        assert.equal(pull.user.login, 'cloud-swe[bot]');
        assert.equal(pull.base.ref, base);
        assert.ok(pull.merged_at, 'GitHub merged it');
        assert.notEqual(await readBranch(token, base), main, 'the merge moved the base branch');

        const comments = await githubJson(
          z.array(Comment),
          token,
          'GET',
          `/repos/${SLUG}/issues/${pull.number}/comments`,
        );

        assert.deepEqual(comments, [{ body: `Comment ${suffix}`, user: { login: 'cloud-swe[bot]' } }]);
      },
    );

    await t.test('the agent deletes a branch with a plain git push', async () => {
      const base = `cloud-swe/live-base-${suffix}`;
      const deleted = await bash(`cd ${REPO} && git push -q origin --delete ${base}`);

      assert.equal(deleted.isError, false, deleted.output);
      assert.equal(await readBranch(token, base), null);
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
  assert.equal(await readBranch(token, 'main'), main);
});
