import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { z } from "zod";
import { buildRepositoryCheckoutCommand, initializeRepository } from "../src/repository.js";
import {
  processResult,
  transportResult,
  type CommandRequest,
  type CommandResult,
  type SandboxProvider,
  type WorkspaceRef,
} from "../src/sandbox.js";

const signal = new AbortController().signal;

const freestyleWorkspace: WorkspaceRef = {
  id: "00000000-0000-4000-8000-000000000001",
  threadId: "00000000-0000-4000-8000-000000000002",
  name: "cloud-swe-00000000-0000-4000-8000-000000000000",
  providerId: "vm-1",
  provider: "freestyle",
  generation: 1,
};

type ShellProcessResult = { stdout: string; stderr: string; statusCode: number };

async function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<ShellProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (statusCode) => resolve({ stdout, stderr, statusCode: statusCode ?? 1 }));
  });
}

async function runShell(
  command: string,
  env: Record<string, string | undefined> = {},
): Promise<ShellProcessResult> {
  return runProcess("bash", ["-c", command], { env });
}

async function runGit(args: string[]) {
  const result = await runProcess("git", args);

  if (result.statusCode !== 0) throw new Error(result.stderr || `git exited ${result.statusCode}`);
}

async function pathExists(path: string) {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
}

async function createUbuntuToolShims(root: string, extraBin?: string): Promise<string> {
  if (process.platform === "linux") return [extraBin, process.env.PATH].filter(Boolean).join(":");
  const tools = join(root, "ubuntu-tools");
  await mkdir(tools, { recursive: true });
  await writeFile(
    join(tools, "du"),
    `#!/bin/sh
if [ "$1" = "-sb" ] && [ "$2" = "--" ]; then
  exec /usr/bin/python3 - "$3" <<'PY'
import os
import sys
path = sys.argv[1]
total = 0
if os.path.isdir(path) and not os.path.islink(path):
    for current, directories, files in os.walk(path):
        for name in directories + files:
            try:
                total += os.lstat(os.path.join(current, name)).st_size
            except FileNotFoundError:
                pass
else:
    total = os.lstat(path).st_size
print(f"{total}\\t{path}")
PY
fi
exec /usr/bin/du "$@"
`,
  );
  await writeFile(
    join(tools, "stat"),
    `#!/bin/sh
if [ "$1" = "-c" ] && [ "$2" = "%d" ] && [ "$3" = "--" ]; then
  exec /usr/bin/python3 -c 'import os,sys; print(os.stat(sys.argv[1]).st_dev)' "$4"
fi
exec /usr/bin/stat "$@"
`,
  );
  await writeFile(
    join(tools, "setsid"),
    `#!/bin/sh
if [ "$1" = "--wait" ]; then shift; fi
exec "$@"
`,
  );
  await chmod(join(tools, "du"), 0o755);
  await chmod(join(tools, "stat"), 0o755);
  await chmod(join(tools, "setsid"), 0o755);

  return [extraBin, tools, process.env.PATH].filter(Boolean).join(":");
}

async function localBareRepository() {
  const root = await mkdtemp(join(tmpdir(), "cloud-swe-repository-test-"));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  await mkdir(source);
  await runGit(["init", "--bare", remote]);
  await runGit(["init", source]);
  await runGit(["-C", source, "checkout", "-b", "main"]);
  await runGit(["-C", source, "config", "user.email", "test@example.com"]);
  await runGit(["-C", source, "config", "user.name", "Cloud SWE test"]);
  await writeFile(join(source, "README.md"), "hello\n");
  await runGit(["-C", source, "add", "README.md"]);
  await runGit(["-C", source, "commit", "-m", "initial"]);
  await runGit(["-C", source, "remote", "add", "origin", remote]);
  await runGit(["-C", source, "push", "origin", "main"]);
  await runGit(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);

  return { root, remote };
}

function fakeProvider(result: CommandResult = processResult("cloned\n", "", 0)) {
  let lastRequest: CommandRequest | undefined;

  const provider: SandboxProvider = {
    resolve: async (workspace) => ({ workspace, disposition: "present", recovered: false }),
    ensure: async () => ({
      providerId: "vm-1",
      disposition: "existing",
      recovered: false,
    }),
    exec: async (_workspace, request) => {
      lastRequest = request;

      return result;
    },
    pause: async () => ({
      action: "pause",
      outcome: "completed",
      providerId: "vm-1",
      recovered: false,
    }),
    delete: async () => ({
      action: "delete",
      outcome: "completed",
      providerId: "vm-1",
      recovered: false,
    }),
  };

  return { provider, getLastRequest: () => lastRequest };
}

function checkoutMarker(
  workspaceKey: string,
  workspacePath: string,
  repositoryUrl: string,
  repositoryBranch: string | null,
): string {
  return [
    "version=1",
    `workspace_key=${workspaceKey}`,
    `workspace_path=${workspacePath}`,
    `repository_url=${repositoryUrl}`,
    `repository_branch=${repositoryBranch ?? ""}`,
    "",
  ].join("\n");
}

async function stagedCheckout(
  repository: { root: string; remote: string },
  workspaceKey: string,
  repositoryBranch: string | null = null,
) {
  const workspace = join(repository.root, `${workspaceKey}-workspace`);
  const stagingRoot = join(repository.root, `${workspaceKey}-staging`);
  await mkdir(workspace);
  await mkdir(stagingRoot);
  await runGit([
    "clone",
    "--depth",
    "1",
    "--no-tags",
    "--single-branch",
    "--no-recurse-submodules",
    ...(repositoryBranch ? ["--branch", repositoryBranch] : []),
    repository.remote,
    join(stagingRoot, `${workspaceKey}.staging`),
  ]);
  await writeFile(
    join(stagingRoot, `${workspaceKey}.promotion`),
    checkoutMarker(workspaceKey, workspace, repository.remote, repositoryBranch),
  );

  return { workspace, stagingRoot };
}

test("initializes a public repository with the requested branch and safe clone settings", async () => {
  const fake = fakeProvider();

  const outcome = await initializeRepository({
    sandbox: fake.provider,
    workspace: freestyleWorkspace,
    repositoryUrl: "https://github.com/example/project",
    repositoryBranch: "feature/fix-tests",
    cloneTimeoutMs: 60_000,
    maxBytes: 4_294_967_296,
    minFreeBytes: 2_147_483_648,
    signal,
  });

  expect(outcome).toBe("cloned");
  const request = fake.getLastRequest();
  expect(request?.command).toContain('--no-recurse-submodules --branch "$requested_branch"');
  expect(request?.command).toContain("GIT_TERMINAL_PROMPT=0");
  expect(request?.command).toContain("GIT_CONFIG_GLOBAL=/dev/null");
  expect(request?.command).toContain("/var/lib/cloud-swe/repository");
  expect(request?.command).toContain("setsid --wait git");
  expect(request?.command).toContain('cp -a -- "$staging/." "$workspace/"');
  expect(request?.command).toContain("workspace_key=");
  expect(request?.command).toContain("repository_url=");
  expect(request?.command).toContain("promotion_marker_tmp=");
  expect(request?.command).toContain('mv -f -- "$promotion_marker_tmp" "$promotion_marker"');
  expect(request?.command).not.toContain("workspace_backup");
  expect(request?.command).not.toContain("checkout-complete");
  expect(request?.command).not.toContain("promotion_started");
  expect(request?.command).not.toContain("command -v setsid");
  expect(request?.command).not.toContain("stat -f");
  expect(request?.command).not.toContain("du -sk");
});

test("reuses a complete matching checkout result", async () => {
  const fake = fakeProvider(processResult("reused\n", "", 0));
  await expect(
    initializeRepository({
      sandbox: fake.provider,
      workspace: freestyleWorkspace,
      repositoryUrl: "https://github.com/example/project.git",
      repositoryBranch: null,
      cloneTimeoutMs: 60_000,
      maxBytes: 4_294_967_296,
      minFreeBytes: 2_147_483_648,
      signal,
    }),
  ).resolves.toBe("reused");
});

test("surfaces transport diagnostics and keeps them retryable", async () => {
  const fake = fakeProvider(transportResult("transport-timeout", "provider deadline"));

  const error = await initializeRepository({
    sandbox: fake.provider,
    workspace: freestyleWorkspace,
    repositoryUrl: "https://github.com/example/project.git",
    repositoryBranch: null,
    cloneTimeoutMs: 60_000,
    maxBytes: 4_294_967_296,
    minFreeBytes: 2_147_483_648,
    signal,
  }).catch(z.instanceof(Error).parse);

  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ nonRetryable: false });
  expect(error).toHaveProperty("message", expect.stringContaining("transport-timeout"));
  expect(error).toHaveProperty("message", expect.stringContaining("provider deadline"));
});

test("keeps the local Docker provider from attempting a repository network operation", async () => {
  const fake = fakeProvider();

  const workspace: WorkspaceRef = {
    ...freestyleWorkspace,
    provider: "docker",
    providerId: "local",
  };

  await expect(
    initializeRepository({
      sandbox: fake.provider,
      workspace,
      repositoryUrl: "https://github.com/example/project.git",
      repositoryBranch: null,
      cloneTimeoutMs: 60_000,
      maxBytes: 4_294_967_296,
      minFreeBytes: 2_147_483_648,
      signal,
    }),
  ).rejects.toThrow("local Docker provider has no network");
  expect(fake.getLastRequest()).toBeUndefined();
});

test("initializes an empty workspace when no repository was supplied", async () => {
  const fake = fakeProvider(processResult("", "", 0));
  await expect(
    initializeRepository({
      sandbox: fake.provider,
      workspace: freestyleWorkspace,
      repositoryUrl: null,
      repositoryBranch: null,
      cloneTimeoutMs: 60_000,
      maxBytes: 4_294_967_296,
      minFreeBytes: 2_147_483_648,
      signal,
    }),
  ).resolves.toBe("empty");
  expect(fake.getLastRequest()).toMatchObject({ command: "install -d -m 0755 -- '/workspace'" });
});

test("clones, reuses, and preserves an agent-switched branch", async () => {
  const repository = await localBareRepository();

  try {
    const workspace = join(repository.root, "workspace");
    const stagingRoot = join(repository.root, "staging");
    const path = await createUbuntuToolShims(repository.root);

    const command = () =>
      buildRepositoryCheckoutCommand("test", repository.remote, "main", 60_000, 4_294_967_296, 1, {
        workspacePath: workspace,
        stagingRoot,
      });

    let result = await runShell(command(), { PATH: path });
    expect(result.statusCode).toBe(0);
    expect(result.stdout.trim()).toBe("cloned");
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe("hello\n");

    await runGit(["-C", workspace, "checkout", "-b", "agent-switched"]);
    result = await runShell(command(), { PATH: path });
    expect(result.statusCode).toBe(0);
    expect(result.stdout.trim()).toBe("reused");
    expect(await pathExists(join(stagingRoot, "test.staging"))).toBe(false);
    expect(await pathExists(join(stagingRoot, "test.log"))).toBe(false);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
  }
});

test("recovers a completed promotion when the worker dies before marker cleanup", async () => {
  const repository = await localBareRepository();

  try {
    const workspace = join(repository.root, "workspace");
    const stagingRoot = join(repository.root, "staging");
    const crashBin = join(repository.root, "crash-bin");
    await mkdir(crashBin);
    await writeFile(
      join(crashBin, "cp"),
      `#!/bin/sh
/bin/cp "$@"
status="$?"
if [ "$status" -eq 0 ]; then
  kill -KILL "$PPID" 2>/dev/null || exit 137
fi
exit "$status"
`,
    );
    await chmod(join(crashBin, "cp"), 0o755);
    const path = await createUbuntuToolShims(repository.root, crashBin);

    const command = buildRepositoryCheckoutCommand(
      "crash-window",
      repository.remote,
      "main",
      60_000,
      4_294_967_296,
      1,
      { workspacePath: workspace, stagingRoot },
    );

    const crashed = await runShell(command, { PATH: path });
    expect(crashed.statusCode).not.toBe(0);
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe("hello\n");
    expect(await pathExists(join(stagingRoot, "crash-window.promotion"))).toBe(true);

    const recovered = await runShell(command, {
      PATH: await createUbuntuToolShims(repository.root),
    });

    expect(recovered.statusCode).toBe(0);
    expect(recovered.stdout.trim()).toBe("reused");
    expect(await pathExists(join(stagingRoot, "crash-window.promotion"))).toBe(false);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
  }
});

test("resumes a valid staged copy and cleans a partial runner-owned target", async () => {
  const repository = await localBareRepository();

  try {
    const staged = await stagedCheckout(repository, "resume");
    await writeFile(join(staged.workspace, "partial.txt"), "runner partial\n");

    const command = buildRepositoryCheckoutCommand(
      "resume",
      repository.remote,
      null,
      60_000,
      4_294_967_296,
      1,
      { workspacePath: staged.workspace, stagingRoot: staged.stagingRoot },
    );

    const result = await runShell(command, {
      PATH: await createUbuntuToolShims(repository.root),
    });

    expect(result.statusCode).toBe(0);
    expect(result.stdout.trim()).toBe("cloned");
    expect(await readFile(join(staged.workspace, "README.md"), "utf8")).toBe("hello\n");
    expect(await pathExists(join(staged.workspace, "partial.txt"))).toBe(false);
    expect(await pathExists(join(staged.stagingRoot, "resume.promotion"))).toBe(false);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
  }
});

test("preserves a target and staging checkout when the promotion marker belongs elsewhere", async () => {
  const repository = await localBareRepository();

  try {
    const root = repository.root;
    const workspace = join(root, "workspace");
    const stagingRoot = join(root, "staging");
    await mkdir(workspace);
    await mkdir(stagingRoot);
    await writeFile(join(workspace, "keep-me.txt"), "preserve me\n");
    await writeFile(
      join(stagingRoot, "ownership.promotion"),
      checkoutMarker("other-workspace", workspace, repository.remote, null),
    );

    const command = buildRepositoryCheckoutCommand(
      "ownership",
      repository.remote,
      null,
      60_000,
      4_294_967_296,
      1,
      { workspacePath: workspace, stagingRoot },
    );

    const result = await runShell(command, {
      PATH: await createUbuntuToolShims(root),
    });

    expect(result.statusCode).toBe(65);
    expect(result.stderr).toContain("does not belong");
    expect(await readFile(join(workspace, "keep-me.txt"), "utf8")).toBe("preserve me\n");
    expect(await pathExists(join(stagingRoot, "ownership.promotion"))).toBe(true);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
  }
});

test("checks a mismatched staged origin before clearing a partial target", async () => {
  const requested = await localBareRepository();
  const staged = await localBareRepository();

  try {
    const workspace = join(requested.root, "workspace");
    const stagingRoot = join(requested.root, "staging");
    const staging = join(stagingRoot, "stage-mismatch.staging");
    await mkdir(workspace);
    await mkdir(stagingRoot);
    await writeFile(join(workspace, "keep-me.txt"), "preserve me\n");
    await runGit([
      "clone",
      "--depth",
      "1",
      "--no-tags",
      "--single-branch",
      "--no-recurse-submodules",
      staged.remote,
      staging,
    ]);
    await writeFile(
      join(stagingRoot, "stage-mismatch.promotion"),
      checkoutMarker("stage-mismatch", workspace, requested.remote, null),
    );

    const result = await runShell(
      buildRepositoryCheckoutCommand(
        "stage-mismatch",
        requested.remote,
        null,
        60_000,
        4_294_967_296,
        1,
        { workspacePath: workspace, stagingRoot },
      ),
      { PATH: await createUbuntuToolShims(requested.root) },
    );

    expect(result.statusCode).toBe(65);
    expect(result.stderr).toContain("staging checkout has a mismatched origin");
    expect(await readFile(join(workspace, "keep-me.txt"), "utf8")).toBe("preserve me\n");
  } finally {
    await rm(requested.root, { recursive: true, force: true });
    await rm(staged.root, { recursive: true, force: true });
  }
});

test("preserves an incomplete target when its readable origin mismatches", async () => {
  const requested = await localBareRepository();
  const existing = await localBareRepository();

  try {
    const workspace = join(requested.root, "workspace");
    const stagingRoot = join(requested.root, "staging");
    await mkdir(workspace);
    await mkdir(stagingRoot);
    await runGit(["init", workspace]);
    await runGit(["-C", workspace, "remote", "add", "origin", existing.remote]);
    await rm(join(workspace, ".git", "HEAD"));
    await writeFile(
      join(stagingRoot, "incomplete.promotion"),
      checkoutMarker("incomplete", workspace, requested.remote, null),
    );

    const result = await runShell(
      buildRepositoryCheckoutCommand(
        "incomplete",
        requested.remote,
        null,
        60_000,
        4_294_967_296,
        1,
        { workspacePath: workspace, stagingRoot },
      ),
      { PATH: await createUbuntuToolShims(requested.root) },
    );

    expect(result.statusCode).toBe(65);
    expect(result.stderr).toContain("mismatched origin");
    expect(await pathExists(join(workspace, ".git", "config"))).toBe(true);
    expect(await pathExists(join(stagingRoot, "incomplete.promotion"))).toBe(true);
  } finally {
    await rm(requested.root, { recursive: true, force: true });
    await rm(existing.root, { recursive: true, force: true });
  }
});

test("preserves a valid target with a mismatched origin", async () => {
  const first = await localBareRepository();
  const second = await localBareRepository();

  try {
    const workspace = join(first.root, "workspace");
    const stagingRoot = join(first.root, "staging");
    const path = await createUbuntuToolShims(first.root);

    const otherCommand = buildRepositoryCheckoutCommand(
      "other",
      second.remote,
      null,
      60_000,
      4_294_967_296,
      1,
      { workspacePath: workspace, stagingRoot },
    );

    const initial = await runShell(otherCommand, { PATH: path });
    expect(initial.statusCode).toBe(0);

    const requestedCommand = buildRepositoryCheckoutCommand(
      "other",
      first.remote,
      null,
      60_000,
      4_294_967_296,
      1,
      { workspacePath: workspace, stagingRoot },
    );

    const result = await runShell(requestedCommand, { PATH: path });
    expect(result.statusCode).toBe(65);
    expect(result.stderr).toContain("origin");
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe("hello\n");
  } finally {
    await rm(first.root, { recursive: true, force: true });
    await rm(second.root, { recursive: true, force: true });
  }
});

test("removes an oversized clone staging directory", async () => {
  const repository = await localBareRepository();

  try {
    const workspace = join(repository.root, "workspace");
    const stagingRoot = join(repository.root, "staging");

    const command = buildRepositoryCheckoutCommand(
      "oversized",
      repository.remote,
      null,
      60_000,
      1,
      1,
      { workspacePath: workspace, stagingRoot },
    );

    const result = await runShell(command, {
      PATH: await createUbuntuToolShims(repository.root),
    });

    expect(result.statusCode).toBe(75);
    expect(await pathExists(join(stagingRoot, "oversized.staging"))).toBe(false);
    expect(await pathExists(join(stagingRoot, "oversized.log"))).toBe(false);
    expect(await pathExists(join(workspace, "README.md"))).toBe(false);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
  }
});

test("reserves free space for the staged checkout before promotion", async () => {
  const repository = await localBareRepository();

  try {
    const workspace = join(repository.root, "workspace");
    const stagingRoot = join(repository.root, "staging");
    const bin = join(repository.root, "bin");
    const dfState = join(repository.root, "df-count");
    await mkdir(bin);
    const realDf = (await runShell("command -v df")).stdout.trim();
    const realGit = (await runShell("command -v git")).stdout.trim();
    await writeFile(
      join(bin, "df"),
      [
        "#!/bin/sh",
        `state='${dfState}'`,
        "count=0",
        'if [ -f "$state" ]; then count=$(cat "$state"); fi',
        "count=$((count + 1))",
        'printf \'%s\\n\' "$count" >"$state"',
        'if [ "$count" -ge 3 ]; then',
        "  printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'",
        "  printf 'fake 100 100 0 100%% %s\\n' \"$1\"",
        "else",
        `  exec '${realDf}' "$@"`,
        "fi",
        "",
      ].join("\n"),
    );
    await chmod(join(bin, "df"), 0o755);
    await writeFile(
      join(bin, "git"),
      [
        "#!/bin/sh",
        'for arg in "$@"; do',
        '  if [ "$arg" = "clone" ]; then',
        "    sleep 0.25",
        `    exec '${realGit}' "$@"`,
        "  fi",
        "done",
        `exec '${realGit}' "$@"`,
        "",
      ].join("\n"),
    );
    await chmod(join(bin, "git"), 0o755);

    const result = await runShell(
      buildRepositoryCheckoutCommand(
        "promotion-space",
        repository.remote,
        null,
        60_000,
        4_294_967_296,
        1,
        { workspacePath: workspace, stagingRoot },
      ),
      { PATH: await createUbuntuToolShims(repository.root, bin) },
    );

    expect(result.statusCode).toBe(75);
    expect(result.stderr).toContain("promote the repository");
    expect(await pathExists(join(workspace, "README.md"))).toBe(false);
    expect(await pathExists(join(stagingRoot, "promotion-space.staging"))).toBe(false);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
  }
});

test("terminates a timed-out clone and cleans its staging directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-swe-repository-timeout-test-"));

  try {
    const workspace = join(root, "workspace");
    const stagingRoot = join(root, "staging");
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "clone" ]; then
    exec python3 -c 'import signal,sys,time
def stop(_signum, _frame):
    sys.exit(143)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
time.sleep(30)'
  fi
done
exit 128
`,
    );
    await chmod(join(bin, "git"), 0o755);

    const result = await runShell(
      buildRepositoryCheckoutCommand("timeout", "/unused-remote", null, 1_000, 4_294_967_296, 1, {
        workspacePath: workspace,
        stagingRoot,
      }),
      { PATH: await createUbuntuToolShims(root, bin) },
    );

    expect(result.statusCode).toBe(124);
    expect(await pathExists(join(stagingRoot, "timeout.staging"))).toBe(false);
    expect(await pathExists(join(stagingRoot, "timeout.log"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
