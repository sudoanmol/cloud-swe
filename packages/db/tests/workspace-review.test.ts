import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { access, chmod, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { workspaceReviewProgram } from "../src/workspace-review-program";
import {
  reviewDiffSchema,
  reviewEnvelopeSchema,
  reviewSummarySchema,
  workspaceDiffStatSchema,
  workspaceFileSchema,
  workspacePortsSchema,
} from "../src/workspace-review";

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
  });

  if (result.exitCode !== 0) throw new Error(result.stderr.toString());

  return result.stdout.toString().trim();
}

function review(root: string, ...args: string[]) {
  const program = workspaceReviewProgram.replace("ROOT = '/workspace'", `ROOT = '${root}'`);
  const result = Bun.spawnSync(["python3", "-c", program, ...args]);

  return JSON.parse(result.stdout.toString());
}

/** A clone of a one-commit remote, like the runner's single-branch checkout. */
async function checkout() {
  const base = await mkdtemp(join(tmpdir(), "review-"));
  const remote = join(base, "remote");
  const workspace = join(base, "workspace");
  git(base, "init", "-q", "-b", "main", remote);
  await writeFile(join(remote, "kept.txt"), "one\ntwo\n");
  await writeFile(join(remote, "gone.txt"), "bye\n");
  git(remote, "add", "-A");
  git(remote, "commit", "-qm", "base");
  git(base, "clone", "-q", "--no-tags", "--single-branch", "--branch", "main", remote, workspace);

  return workspace;
}

test("counts committed, unstaged and untracked changes against the branch tip", async () => {
  const workspace = await checkout();
  await writeFile(join(workspace, "kept.txt"), "one\nthree\n");
  git(workspace, "commit", "-qam", "edit kept");
  git(workspace, "rm", "-q", "gone.txt");
  await writeFile(join(workspace, "new.txt"), "a\nb\n");
  const index = await readFile(join(workspace, ".git", "index"));

  const stat = reviewEnvelopeSchema(workspaceDiffStatSchema).parse(
    review(workspace, "stat", "main"),
  );

  expect(stat).toEqual({ ok: true, result: { files: 3, additions: 3, deletions: 2 } });
  // The review uses a private index; the agent's staging area is untouched.
  expect(await readFile(join(workspace, ".git", "index"))).toEqual(index);

  const uncommitted = reviewEnvelopeSchema(reviewDiffSchema).parse(
    review(workspace, "review", "main", "uncommitted"),
  );

  expect(uncommitted.ok && uncommitted.result?.files.map((file) => file.path)).toEqual([
    "gone.txt",
    "new.txt",
  ]);
});

test("lists sandbox commits and diffs one commit", async () => {
  const workspace = await checkout();
  await writeFile(join(workspace, "kept.txt"), "one\nthree\n");
  git(workspace, "commit", "-qam", "edit kept");
  const sha = git(workspace, "rev-parse", "HEAD");

  const summary = reviewEnvelopeSchema(reviewSummarySchema).parse(
    review(workspace, "summary", "main"),
  );

  expect(summary.ok && summary.result).toMatchObject({
    head: "main",
    base: "origin/main",
    commits: [{ sha, subject: "edit kept" }],
  });

  const commit = reviewEnvelopeSchema(reviewDiffSchema).parse(
    review(workspace, "review", "main", "commit", sha),
  );

  expect(commit.ok && commit.result?.files).toEqual([
    { path: "kept.txt", oldPath: null, binary: false, additions: 1, deletions: 1 },
  ]);
});

test("reads files only inside the workspace", async () => {
  const workspace = await checkout();
  const file = reviewEnvelopeSchema(workspaceFileSchema);

  expect(file.parse(review(workspace, "read", "kept.txt"))).toMatchObject({
    ok: true,
    result: { kind: "text", contents: "one\ntwo\n" },
  });
  expect(file.parse(review(workspace, "read", "../remote/kept.txt")).ok).toBe(false);
  // A symlink inside the workspace cannot redirect a read outside it.
  await symlink(join(workspace, "..", "remote"), join(workspace, "outside"));
  expect(file.parse(review(workspace, "read", "outside/kept.txt")).ok).toBe(false);
});

test("never runs repository filters, hooks or fsmonitor", async () => {
  const workspace = await checkout();
  const marker = join(workspace, "..", "ran");
  const probe = join(workspace, "..", "probe.sh");
  await writeFile(probe, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
  await chmod(probe, 0o755);
  await writeFile(join(workspace, ".git", "info", "attributes"), "*.txt filter=probe\n");
  git(workspace, "config", "filter.probe.clean", probe);
  git(workspace, "config", "filter.probe.process", probe);
  git(workspace, "config", "core.fsmonitor", probe);
  await writeFile(join(workspace, ".git", "hooks", "post-index-change"), `#!/bin/sh\n${probe}\n`);
  await chmod(join(workspace, ".git", "hooks", "post-index-change"), 0o755);
  await writeFile(join(workspace, "kept.txt"), "changed\n");

  for (const args of [["stat", "main"], ["review", "main", "all"], ["summary", "main"], ["files"]])
    expect(review(workspace, ...args).ok).toBe(true);

  expect(
    await access(marker).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
});

test.skipIf(!existsSync("/proc/net/tcp"))("lists listening TCP ports", () => {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });

  try {
    const ports = reviewEnvelopeSchema(workspacePortsSchema).parse(review("/nonexistent", "ports"));

    expect(ports.ok && ports.result).toContain(server.port);
  } finally {
    server.stop(true);
  }
});
