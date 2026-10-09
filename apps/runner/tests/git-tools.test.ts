import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiGitTools, fetchGitAccess } from "../src/git-tools";
import { processResult } from "../src/sandbox";

test("guest Git config authors commits as the signed-in user", async () => {
  const name = 'Ada "the" Lovelace\\';
  const directory = await mkdtemp(join(tmpdir(), "git-access-"));
  const file = join(directory, "git.config");

  const access = await fetchGitAccess({
    call: async () => ({
      repositoryUrl: "https://github.com/acme/repo.git",
      url: "https://broker.example/git/read",
      token: "read-capability",
      expires: Date.now() + 900_000,
      identity: { name, email: "1+ada@users.noreply.github.com" },
    }),
  });

  try {
    await writeFile(file, access.config);

    const read = (key: string) =>
      execFileSync("git", ["config", "--file", file, key]).toString().trim();

    expect(read("user.name")).toBe(name);
    expect(read("user.email")).toBe("1+ada@users.noreply.github.com");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent readers share a complete access refresh and can retry a failed refresh", async () => {
  const installStarted = Promise.withResolvers<void>();
  const installation = Promise.withResolvers<void>();
  let requests = 0;
  let writes = 0;
  let fail = false;

  const git = createPiGitTools({
    client: {
      call: async () => {
        requests++;

        if (fail) throw new Error("Broker unavailable");

        return {
          repositoryUrl: "https://github.com/acme/repo.git",
          url: "https://broker.example/git/read",
          token: "read-capability",
          expires: Date.now() + 900_000,
          identity: { name: "Ada", email: "1+ada@users.noreply.github.com" },
        };
      },
    },
    exec: async () => {
      writes++;
      installStarted.resolve();
      await installation.promise;

      return processResult("", "", 0);
    },
    maxBytes: 1024,
    minFreeBytes: 0,
  });

  let completed = 0;

  const readers = Array.from({ length: 4 }, async () => {
    await git.refreshAccess();
    completed++;
  });

  try {
    await installStarted.promise;
    expect(requests).toBe(1);
    expect(writes).toBe(1);
    expect(completed).toBe(0);
  } finally {
    installation.resolve();
    await Promise.all(readers);
  }

  await git.refreshAccess();
  expect(requests).toBe(1);
  fail = true;
  const failures = await Promise.allSettled([git.refreshAccess(true), git.refreshAccess(true)]);
  expect(failures.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  expect(requests).toBe(2);
  fail = false;
  await git.refreshAccess(true);
  expect(requests).toBe(3);
  expect(writes).toBe(2);
});

test("new Git capabilities publish proposals and wait without dispatching", async () => {
  const { gitRequestSchema } = await import("@cloud-swe/db/git-contracts");

  for (const [name, value] of [
    ["github_pr_ready", { kind: "pr_ready", number: 1 }],
    ["github_pr_review_reply", { kind: "pr_review_reply", number: 1, commentId: 5, body: "Reply" }],
    ["github_pr_review_resolve", { kind: "pr_review_resolve", threadId: "thread-1" }],
  ] as const) {
    const calls: string[] = [];
    const request = gitRequestSchema.parse(value);

    const git = createPiGitTools({
      client: {
        call: async (path) => {
          calls.push(path);

          return {
            id: "11111111-1111-4111-8111-111111111111",
            toolCallId: "tool",
            repositoryUrl: "https://github.com/acme/repo.git",
            repositoryId: 1,
            request,
            expectedHead: "a".repeat(40),
            base: "main",
            commit: null,
            bundleHash: null,
            preview: "",
            digest: "b".repeat(64),
          };
        },
      },
      exec: async () => {
        throw new Error("PR proposal must not execute a workspace command");
      },
      maxBytes: 1024,
      minFreeBytes: 0,
    });

    expect(git.tools.some((tool) => tool.name === name)).toBe(true);
    const result = await git.propose(request, "tool");
    expect(result.terminate).toBe(true);
    expect(git.pending()?.request).toEqual(request);
    expect(calls).toEqual(["prepare"]);
  }
});
