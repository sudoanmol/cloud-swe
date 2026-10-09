import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { manualGitLocalSchema } from "@cloud-swe/db/manual-git";

const program = new URL("../src/guest/manual-git.py", import.meta.url).pathname;

test("the check snapshots without moving refs; the commit refuses changed files and is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "manual-git-"));

  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();

  const run = (request: { kind: string; base?: string; fingerprint?: string; message?: string }) =>
    spawnSync("python3", [program], {
      cwd: root,
      input: JSON.stringify({ runId: "test-run", generation: 1, ...request }),
      encoding: "utf8",
    });

  try {
    git("init", "--initial-branch=feature");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.test");
    await writeFile(join(root, "file.txt"), "initial\n");
    git("add", ".");
    git("commit", "-m", "Initial commit");
    await writeFile(join(root, "file.txt"), "changed\n");
    await writeFile(join(root, "new.txt"), "untracked\n");

    const head = git("rev-parse", "HEAD");

    const preview = manualGitLocalSchema.parse(
      JSON.parse(run({ kind: "check", base: "main" }).stdout),
    );

    expect(preview).toMatchObject({ branch: "feature", head, dirty: true, changedFiles: 2 });
    expect(preview.diff).toContain("+changed");
    // The snapshot holds every change but moves neither the branch nor the index.
    expect(git("ls-tree", "--name-only", preview.commit)).toBe("file.txt\nnew.txt");
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("status", "--porcelain")).toBe("M file.txt\n?? new.txt");
    await writeFile(join(root, "new.txt"), "different\n");
    expect(
      run({ kind: "commit", fingerprint: preview.fingerprint, message: "Edited message" }).status,
    ).not.toBe(0);
    await writeFile(join(root, "new.txt"), "untracked\n");
    const request = { kind: "commit", fingerprint: preview.fingerprint, message: "Edited message" };
    const first = run(request);
    expect(first.status).toBe(0);
    expect(run(request).stdout).toBe(first.stdout);
    expect(git("rev-list", "--count", "HEAD")).toBe("2");
    expect(git("log", "-1", "--format=%s")).toBe("Edited message");
    // The commit is authored by the configured identity, the user's in the sandbox.
    expect(git("log", "-1", "--format=%an <%ae>")).toBe("Test <test@example.test>");
    expect(git("status", "--porcelain")).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
