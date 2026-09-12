import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { Client, Pool } from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import Fastify from "fastify";
import { createDb } from "@cloud-swe/db";
import { createThreadStore } from "@cloud-swe/db/threads";
import { createGitStore } from "@cloud-swe/db/git-store";
import { gitProposalSchema, type GitProposal } from "@cloud-swe/db/git-contracts";
import { createGithubClient } from "../src/github";
import { createGitBundles, brokerGit } from "../src/git-bundles";
import { registerGitBroker, signGitCapability } from "../src/git-broker";

const database = `git_broker_${randomUUID().replaceAll("-", "")}`;

const baseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:password@localhost:5432/cloud-swe";

const userId = `git-user-${randomUUID()}`;

const secret = "test-only-broker-key-".repeat(3);

const upstreamSecret = "github-upstream-secret-not-for-guest";

const repositoryUrl = "https://github.com/acme/private.git";

let admin: Client;

let pool: Pool;

let threads: ReturnType<typeof createThreadStore>;

let gitStore: ReturnType<typeof createGitStore>;

let app: ReturnType<typeof Fastify>;

let root: string;

let address: string;

let upstream: string;

let local: string;

let baseCommit: string;

let linked = true;

let posts = 0;

let revoked = false;

let createdPosts = 0;

let loseCreateResponse = false;

const pullRequests: Array<{
  number: number;
  html_url: string;
  title: string;
  body: string;
  state: string;
  merged: boolean;
  head: { sha: string; ref: string };
  base: { ref: string; repo: { id: number } };
}> = [];

let loseResponse = false;

const comments: Array<{ id: number; html_url: string; body: string; user: { id: number } }> = [];

const repo = {
  id: 101,
  name: "private",
  full_name: "acme/private",
  private: true,
  default_branch: "main",
  html_url: "https://github.com/acme/private",
  clone_url: repositoryUrl,
  permissions: { pull: true, push: true },
};

async function git(cwd: string, args: string[]) {
  const result = await brokerGit(cwd, args);

  if (result.code) throw new Error(`git ${args[0]} failed`);

  return result.stdout.trim();
}

async function gitHttp(url: URL, init?: RequestInit) {
  const input = init?.body instanceof Buffer ? init.body : Buffer.alloc(0);

  return new Promise<Response>((resolve, reject) => {
    const process = spawn("git", ["http-backend"], {
      env: {
        PATH: globalThis.process.env.PATH,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: `/upstream.git/${url.pathname.split("/").slice(3).join("/")}`,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: init?.method ?? "GET",
        CONTENT_TYPE: "application/x-git-upload-pack-request",
        CONTENT_LENGTH: String(input.length),
        GIT_PROTOCOL: new Headers(init?.headers).get("Git-Protocol") ?? "",
      },
      stdio: ["pipe", "pipe", "ignore"],
    });

    const chunks: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.on("error", reject);
    process.on("close", () => {
      const bytes = Buffer.concat(chunks);
      const divider = bytes.indexOf("\r\n\r\n");
      const headers = new Headers();
      let status = 200;

      for (const line of bytes.subarray(0, divider).toString().split("\r\n")) {
        const colon = line.indexOf(":");

        if (colon < 0) continue;

        if (line.slice(0, colon).toLowerCase() === "status")
          status = Number(
            line
              .slice(colon + 1)
              .trim()
              .split(" ")[0],
          );
        else headers.set(line.slice(0, colon), line.slice(colon + 1).trim());
      }

      resolve(new Response(bytes.subarray(divider + 4), { status, headers }));
    });
    process.stdin.end(input);
  });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cloud-swe-git-"));
  upstream = join(root, "upstream.git");
  local = join(root, "local");
  await git(root, ["init", "--bare", "--initial-branch=main", upstream]);
  await git(root, ["init", "--initial-branch=main", local]);
  await git(local, ["config", "user.name", "Test"]);
  await git(local, ["config", "user.email", "test@example.test"]);
  await writeFile(join(local, "README.md"), "initial\n");
  await git(local, ["add", "."]);
  await git(local, ["commit", "-m", "initial"]);
  baseCommit = await git(local, ["rev-parse", "HEAD"]);
  await git(local, ["push", upstream, "main"]);
  admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  const dbUrl = new URL(baseUrl);
  dbUrl.pathname = `/${database}`;
  pool = new Pool({ connectionString: dbUrl.toString() });
  const db = createDb(pool);
  await migrate(db, {
    migrationsFolder: new URL("../../db/src/migrations", import.meta.url).pathname,
  });
  await pool.query('insert into "user"(id,name,email) values($1,$2,$3)', [
    userId,
    "Git tester",
    `${userId}@example.test`,
  ]);
  threads = createThreadStore(db, { primaryGithubAccountId: "919191" });
  await pool.query(
    "insert into account(id, issuer, account_id, provider_id, user_id, updated_at) values($1, 'github', '919191', 'github', $2, now())",
    [randomUUID(), userId],
  );
  gitStore = createGitStore(db);

  const fetcher: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));

      if (url.hostname === "github.com") {
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          `Basic ${Buffer.from(`x-access-token:${upstreamSecret}`).toString("base64")}`,
        );

        return gitHttp(url, init);
      }

      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${upstreamSecret}`);

      if (url.pathname === "/user/repos") return Response.json([repo]);

      if (url.pathname === "/repos/acme/private")
        return revoked ? new Response(null, { status: 403 }) : Response.json(repo);

      if (url.pathname.startsWith("/repos/acme/private/git/ref/heads/"))
        return Response.json({ object: { sha: baseCommit } });

      if (url.pathname === "/repos/acme/private/pulls") {
        if (init?.method === "POST") {
          createdPosts++;
          const body = JSON.parse(String(init.body));

          const pr = {
            number: 2,
            html_url: "https://github.com/acme/private/pull/2",
            title: body.title,
            body: body.body,
            state: "open",
            merged: false,
            head: { sha: baseCommit, ref: body.head },
            base: { ref: body.base, repo: { id: repo.id } },
          };

          pullRequests.push(pr);

          if (loseCreateResponse) throw new Error("Lost create response");

          return Response.json(pr);
        }

        return Response.json(pullRequests);
      }

      if (url.pathname.startsWith("/repos/acme/private/pulls/2")) {
        const pr = pullRequests[0];

        if (!pr) return new Response(null, { status: 404 });

        if (url.pathname.endsWith("/merge") && init?.method === "PUT") {
          expect(JSON.parse(String(init.body)).sha).toBe(baseCommit);
          pr.merged = true;
          pr.state = "closed";

          return Response.json({ merged: true, sha: baseCommit });
        }

        if (init?.method === "PATCH") Object.assign(pr, JSON.parse(String(init.body)));

        return Response.json(pr);
      }

      if (url.pathname === "/repos/acme/private/branches")
        return Response.json([
          {
            name: "main",
            protected: false,
            commit: { sha: baseCommit, url: "https://api.github.com/commit" },
          },
        ]);

      if (url.pathname === "/repos/acme/private/pulls/1")
        return Response.json({
          number: 1,
          html_url: "https://github.com/acme/private/pull/1",
          title: "Test",
          body: "body",
          state: "open",
          head: { sha: baseCommit, ref: "feature" },
          base: { ref: "main", repo: { id: repo.id } },
        });

      if (url.pathname === "/repos/acme/private/issues/1/comments") {
        if (init?.method === "POST") {
          posts++;
          const { body } = JSON.parse(String(init.body));

          const comment = {
            id: posts,
            html_url: `https://github.com/acme/private/pull/1#issuecomment-${posts}`,
            body,
            user: { id: 1 },
          };

          comments.push(comment);

          if (loseResponse) throw new Error(`socket lost ${upstreamSecret}`);

          return Response.json(comment);
        }

        return Response.json(comments);
      }

      return Response.json({ message: upstreamSecret }, { status: 404 });
    },
    { preconnect: fetch.preconnect },
  );

  const github = createGithubClient(async () => {
    if (!linked) throw new Error("Access revoked");

    return upstreamSecret;
  }, fetcher);

  app = Fastify();
  registerGitBroker(app, {
    store: gitStore,
    github,
    bundles: createGitBundles(join(root, "staging"), 8_388_608, 0),
    maxBytes: 8_388_608,
    secret,
    publicUrl: "http://localhost",
    trustedOrigins: ["http://localhost:3001"],
    auth: {
      getSession: async (headers) =>
        headers.get("cookie") === "session=test" ? { user: { id: userId }, session: {} } : null,
      handler: async () => new Response(),
    },
  });
  address = await app.listen({ host: "127.0.0.1", port: 0 });
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await admin?.query(`DROP DATABASE IF EXISTS "${database}"`);
  await admin?.end();

  if (root) await rm(root, { recursive: true, force: true });
});

async function runFixture() {
  // Finish prior runs to preserve the real admission policy.
  await pool.query("update run set status='completed' where user_id=$1", [userId]);

  const run = await threads.submitThread({
    userId,
    prompt: "Git test",
    clientMessageId: randomUUID(),
    repositoryUrl,
  });

  await threads.startRun(run.runId);
  await threads.updateWorkspace({ threadId: run.threadId, state: "running", provider: "docker" });

  const owner = await threads.claimExecutionOwnership({
    runId: run.runId,
    generation: 1,
    attemptId: randomUUID(),
  });

  return {
    ...run,
    context: { runId: run.runId, generation: 1, ownershipToken: owner.token },
    owner,
  };
}

const internalHeaders = { authorization: `Bearer ${secret}` };

const sessionHeaders = { cookie: "session=test" };

test("repository and branch listing use the broker and expose no tokens", async () => {
  const repos = await app.inject({
    method: "GET",
    url: "/api/github/repositories?page=1",
    headers: sessionHeaders,
  });

  expect(repos.statusCode).toBe(200);
  expect(repos.json().items[0].private).toBe(true);
  expect(repos.body).not.toContain(upstreamSecret);
  expect((await app.inject({ method: "GET", url: "/api/github/repositories" })).statusCode).toBe(
    401,
  );
  expect(
    (
      await app.inject({
        method: "GET",
        url: "/api/github/repositories/acme/private/branches",
        headers: sessionHeaders,
      })
    ).json().items[0].name,
  ).toBe("main");
  expect(
    (
      await app.inject({
        method: "GET",
        url: "/api/github/repositories?page=0",
        headers: sessionHeaders,
      })
    ).statusCode,
  ).toBe(400);
});

test("real Git clone and fetch traverse the read-only proxy, which rejects writes and stale capabilities", async () => {
  const f = await runFixture();

  const token = signGitCapability(secret, {
    kind: "read",
    context: f.context,
    expires: Date.now() + 60_000,
  });

  const args = [
    "-c",
    `url.${address}/git/read.insteadOf=${repositoryUrl}`,
    "-c",
    `http.${address}/git/read.extraHeader=Authorization: Bearer ${token}`,
  ];

  const checkout = join(root, "cloned");
  await git(root, [...args, "clone", "--depth=1", repositoryUrl, checkout]);
  expect(await git(checkout, ["remote", "get-url", "origin"])).toBe(repositoryUrl);
  await git(checkout, [...args, "fetch", "origin"]);
  expect(
    (
      await app.inject({
        method: "GET",
        url: "/git/read/info/refs?service=git-receive-pack",
        headers: { authorization: `Bearer ${token}` },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/git/read/git-receive-pack",
        headers: { authorization: `Bearer ${token}` },
      })
    ).statusCode,
  ).toBe(400);

  const stale = signGitCapability(secret, {
    kind: "read",
    context: f.context,
    expires: Date.now() - 1,
  });

  expect(
    (
      await app.inject({
        method: "GET",
        url: "/git/read/info/refs?service=git-upload-pack",
        headers: { authorization: `Bearer ${stale}` },
      })
    ).statusCode,
  ).toBe(403);
  await threads.claimExecutionOwnership({ runId: f.runId, generation: 1, attemptId: randomUUID() });
  expect(
    (
      await app.inject({
        method: "GET",
        url: "/git/read/info/refs?service=git-upload-pack",
        headers: { authorization: `Bearer ${token}` },
      })
    ).statusCode,
  ).toBe(409);
}, 30_000);

test("PR writes require approval and lost responses reconcile without posting twice", async () => {
  const f = await runFixture();

  const prepared = await app.inject({
    method: "POST",
    url: "/internal/git/prepare",
    headers: internalHeaders,
    payload: {
      context: f.context,
      toolCallId: "comment-1",
      request: { kind: "pr_comment", number: 1, body: "Ready to review" },
    },
  });

  expect(prepared.statusCode).toBe(200);
  const proposal = gitProposalSchema.parse(prepared.json());
  await threads.saveCheckpoint({
    runId: f.runId,
    key: "pi-session",
    generation: 1,
    attemptId: f.owner.attemptId,
    ownershipToken: f.owner.token,
    content: {
      sessionId: "s",
      provider: "test",
      model: "test",
      entries: [
        {
          type: "session",
          version: 3,
          id: "s",
          timestamp: "2026-09-12T00:00:00.000Z",
          cwd: "/workspace",
        },
      ],
    },
    gitProposal: proposal,
  });

  const execute = () =>
    app.inject({
      method: "POST",
      url: "/internal/git/execute",
      headers: internalHeaders,
      payload: { context: f.context, id: proposal.id },
    });

  expect((await execute()).json().approval).toBe("pending");
  expect(posts).toBe(0);
  const url = `/api/threads/${f.threadId}/git-operations/${proposal.id}/decision`;
  expect(
    (
      await app.inject({
        method: "POST",
        url,
        headers: sessionHeaders,
        payload: { decision: "approve", digest: proposal.digest },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: "POST",
        url,
        headers: { ...sessionHeaders, origin: "http://localhost:3001", "x-csrf-protection": "1" },
        payload: { decision: "approve", digest: proposal.digest },
      })
    ).statusCode,
  ).toBe(200);
  loseResponse = true;
  const lost = await execute();
  expect(lost.json().execution).toBe("unknown");
  expect(lost.body).not.toContain(upstreamSecret);
  loseResponse = false;
  const recovered = await execute();
  expect(recovered.json().execution).toBe("succeeded");
  expect(posts).toBe(1);
  expect((await execute()).json().execution).toBe("succeeded");
  expect(posts).toBe(1);
});

test("staged bundles push the approved commit and reject changed destinations and tampering", async () => {
  const bundleStore = createGitBundles(join(root, "bundle-tests"), 8_388_608, 0);
  const id = randomUUID();
  await writeFile(join(local, "README.md"), "changed\n");
  await git(local, ["add", "."]);
  await git(local, ["commit", "-m", "change"]);
  const commit = await git(local, ["rev-parse", "HEAD"]);
  await git(local, ["update-ref", `refs/cloud-swe/export/${id}`, commit]);
  const bundle = join(root, "change.bundle");
  await git(local, ["bundle", "create", bundle, `refs/cloud-swe/export/${id}`]);
  await bundleStore.upload(id, createReadStream(bundle));
  const details = await bundleStore.prepare(id, commit, upstream, "main", "");
  expect(details.expectedHead).toBe(baseCommit);
  expect(details.preview).toContain("+changed");

  const proposal: GitProposal = {
    id,
    repositoryId: repo.id,
    repositoryUrl: upstream,
    toolCallId: "push",
    request: { kind: "push", source: "HEAD", branch: "main" },
    commit,
    base: null,
    ...details,
    digest: "a".repeat(64),
  };

  expect(await bundleStore.push(proposal, "")).toBe(true);
  expect(await git(upstream, ["rev-parse", "main"])).toBe(commit);
  // A different destination value must not be overwritten by a stale approval.
  await git(upstream, ["update-ref", "refs/heads/main", baseCommit]);
  await git(upstream, ["update-ref", "refs/heads/main", commit]);
  await expect(bundleStore.push({ ...proposal, commit: baseCommit }, "")).rejects.toMatchObject({
    code: "GIT_PROPOSAL_STALE",
  });
  await writeFile(join(root, "bundle-tests", id, "source.bundle"), "tampered");
  await expect(bundleStore.push(proposal, "")).rejects.toMatchObject({
    code: "GIT_PROPOSAL_STALE",
  });
}, 30_000);

test("access revocation prevents approved dispatch and read capability reuse", async () => {
  const f = await runFixture();

  const prepared = await app.inject({
    method: "POST",
    url: "/internal/git/prepare",
    headers: internalHeaders,
    payload: {
      context: f.context,
      toolCallId: "revoked",
      request: { kind: "pr_comment", number: 1, body: "Do not post" },
    },
  });

  const proposal = gitProposalSchema.parse(prepared.json());
  await threads.saveCheckpoint({
    runId: f.runId,
    key: "pi-session",
    generation: 1,
    attemptId: f.owner.attemptId,
    ownershipToken: f.owner.token,
    content: {
      sessionId: "s",
      provider: "test",
      model: "test",
      entries: [
        {
          type: "session",
          version: 3,
          id: "s",
          timestamp: "2026-09-12T00:00:00.000Z",
          cwd: "/workspace",
        },
      ],
    },
    gitProposal: proposal,
  });
  await gitStore.decision({
    userId,
    threadId: f.threadId,
    id: proposal.id,
    digest: proposal.digest,
    decision: "approve",
  });

  const token = signGitCapability(secret, {
    kind: "read",
    context: f.context,
    expires: Date.now() + 60_000,
  });

  revoked = true;
  const before = posts;

  try {
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/git/read/info/refs?service=git-upload-pack",
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(403);

    const result = await app.inject({
      method: "POST",
      url: "/internal/git/execute",
      headers: internalHeaders,
      payload: { context: f.context, id: proposal.id },
    });

    expect(result.json()).toMatchObject({
      execution: "failed",
      result: { code: "GIT_ACCESS_DENIED" },
    });
    expect(posts).toBe(before);
  } finally {
    revoked = false;
  }
});

test("PR creation reconciles a lost response once, then update, close, reopen and merge use approved endpoints", async () => {
  const requests = [
    {
      kind: "pr_create",
      title: "Proposed",
      body: "Exact text",
      head: "feature",
      base: "main",
      draft: false,
    },
    { kind: "pr_update", number: 2, title: "Updated", body: "Updated body" },
    { kind: "pr_close", number: 2 },
    { kind: "pr_reopen", number: 2 },
    { kind: "pr_merge", number: 2, method: "squash" },
  ];

  for (const request of requests) {
    const f = await runFixture();

    const response = await app.inject({
      method: "POST",
      url: "/internal/git/prepare",
      headers: internalHeaders,
      payload: { context: f.context, toolCallId: request.kind, request },
    });

    expect(response.statusCode).toBe(200);
    const proposal = gitProposalSchema.parse(response.json());
    await threads.saveCheckpoint({
      runId: f.runId,
      key: "pi-session",
      generation: 1,
      attemptId: f.owner.attemptId,
      ownershipToken: f.owner.token,
      content: {
        sessionId: "s",
        provider: "test",
        model: "test",
        entries: [
          {
            type: "session",
            version: 3,
            id: "s",
            timestamp: "2026-09-12T00:00:00.000Z",
            cwd: "/workspace",
          },
        ],
      },
      gitProposal: proposal,
    });
    await gitStore.decision({
      userId,
      threadId: f.threadId,
      id: proposal.id,
      digest: proposal.digest,
      decision: "approve",
    });

    const execute = () =>
      app.inject({
        method: "POST",
        url: "/internal/git/execute",
        headers: internalHeaders,
        payload: { context: f.context, id: proposal.id },
      });

    if (request.kind === "pr_create") {
      loseCreateResponse = true;
      expect((await execute()).json().execution).toBe("unknown");
      loseCreateResponse = false;
    }

    expect((await execute()).json().execution).toBe("succeeded");
  }

  expect(createdPosts).toBe(1);
  expect(pullRequests[0]).toMatchObject({
    title: "Updated",
    body: "Updated body",
    merged: true,
    state: "closed",
  });
});

test("concurrent token requests coalesce refresh without caching credentials", async () => {
  let refreshes = 0;
  const gate = Promise.withResolvers<string>();

  const github = createGithubClient(async () => {
    refreshes++;

    return gate.promise;
  });

  const first = github.token("user");
  const second = github.token("user");
  gate.resolve("token");
  expect(await Promise.all([first, second])).toEqual(["token", "token"]);
  expect(refreshes).toBe(1);
  await github.token("user");
  expect(refreshes).toBe(2);
});

test("bundle staging rejects invalid objects, non-fast-forward history, and oversized uploads", async () => {
  const bundles = createGitBundles(join(root, "invalid-bundles"), 8_388_608, 0);
  const invalid = randomUUID();
  const invalidFile = join(root, "invalid.bundle");
  await writeFile(invalidFile, "not a Git bundle");
  await bundles.upload(invalid, createReadStream(invalidFile));
  await expect(bundles.prepare(invalid, baseCommit, upstream, "main", "")).rejects.toMatchObject({
    code: "GIT_BUNDLE_INVALID",
  });
  const old = randomUUID();
  await git(local, ["update-ref", `refs/cloud-swe/export/${old}`, baseCommit]);
  const oldBundle = join(root, "old.bundle");
  await git(local, ["bundle", "create", oldBundle, `refs/cloud-swe/export/${old}`]);
  await bundles.upload(old, createReadStream(oldBundle));
  await expect(bundles.prepare(old, baseCommit, upstream, "main", "")).rejects.toMatchObject({
    code: "GIT_NON_FAST_FORWARD",
  });
  const tiny = createGitBundles(join(root, "tiny-bundles"), 4, 0);
  await expect(tiny.upload(randomUUID(), createReadStream(invalidFile))).rejects.toMatchObject({
    code: "GIT_BUNDLE_INVALID",
  });
});
