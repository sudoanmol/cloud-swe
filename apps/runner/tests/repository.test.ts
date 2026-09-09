import { access, chmod, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { buildRepositoryCheckoutCommand, initializeRepository } from "../src/repository.js";
import type {
  CommandRequest,
  CommandResult,
  SandboxProvider,
  WorkspaceRef,
} from "../src/sandbox.js";

const signal = new AbortController().signal;
const freestyleWorkspace: WorkspaceRef = {
  name: "cloud-swe-00000000-0000-4000-8000-000000000000",
  providerId: "vm-1",
  provider: "freestyle",
};

type ProcessResult = { stdout: string; stderr: string; statusCode: number };

async function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<ProcessResult> {
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

async function runShell(command: string, env: Record<string, string | undefined> = {}) {
  return runProcess("bash", ["-c", command], { env });
}

async function runPosixShell(command: string, env: Record<string, string | undefined> = {}) {
  return runProcess("sh", ["-c", command], { env });
}

async function runGit(args: string[]) {
  const result = await runProcess("git", args);
  if (result.statusCode !== 0) throw new Error(result.stderr || `git exited ${result.statusCode}`);
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
  return { root, remote };
}

async function pathExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function fakeProvider(result: CommandResult = { stdout: "cloned\n", stderr: "", statusCode: 0 }) {
  let lastRequest: CommandRequest | string | undefined;
  const exec = async (
    _workspace: WorkspaceRef | string,
    request: CommandRequest | string,
    _signal: AbortSignal,
  ): Promise<CommandResult> => {
    lastRequest = request;
    return result;
  };
  const provider: SandboxProvider = {
    ensure: async () => ({ providerId: "vm-1" }),
    exec,
    execStep: async () => "",
    pause: async () => true,
    delete: async () => undefined,
  };
  return { provider, getLastRequest: () => lastRequest };
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
  expect(typeof request === "object" && request !== null ? request.command : request).toContain(
    "--depth 1 --no-tags --single-branch --branch 'feature/fix-tests'",
  );
  expect(typeof request === "object" && request !== null ? request.command : request).toContain(
    "GIT_TERMINAL_PROMPT=0",
  );
  expect(typeof request === "object" && request !== null ? request.command : request).toContain(
    "GIT_CONFIG_GLOBAL=/dev/null",
  );
  const command = typeof request === "object" && request !== null ? request.command : request;
  expect(command).toContain("/var/lib/cloud-swe/repository");
  expect(command).toContain("workspace_backup='/var/lib/cloud-swe/repository/");
  expect(command).toContain(".workspace-backup'");
  expect(command).toContain("setsid --wait git");
  expect(command).toContain('cp -a -- "$staging"/. "$workspace"/');
  expect(command).toContain('promotion_marker="$staging_parent/');
  expect(command).not.toContain("/workspace/.cloud-swe-clone-staging");
  expect(command).not.toContain("/workspace/.cloud-swe-clone.log");
});

test("reuses a complete matching checkout", async () => {
  const fake = fakeProvider({ stdout: "reused\n", stderr: "", statusCode: 0 });
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
  const fake = fakeProvider({ stdout: "", stderr: "", statusCode: 0 });
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

test("executes an atomic checkout and preserves files during reuse and recovery", async () => {
  const repository = await localBareRepository();
  try {
    const workspace = join(repository.root, "workspace");
    const stagingRoot = join(repository.root, "staging");
    const backup = join(repository.root, "workspace-backup");
    const command = () =>
      buildRepositoryCheckoutCommand("test", repository.remote, null, 60_000, 4_294_967_296, 1, {
        workspacePath: workspace,
        stagingRoot,
        workspaceBackupPath: backup,
      });

    let result = await runShell(command());
    expect(result.statusCode).toBe(0);
    expect(result.stdout.trim()).toBe("cloned");
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe("hello\n");

    await writeFile(join(workspace, ".cloud-swe-clone.log"), "user file\n");
    result = await runShell(command());
    expect(result.statusCode).toBe(0);
    expect(result.stdout.trim()).toBe("reused");
    expect(await readFile(join(workspace, ".cloud-swe-clone.log"), "utf8")).toBe("user file\n");
    expect(await pathExists(join(stagingRoot, "test.staging"))).toBe(false);
    expect(await pathExists(join(stagingRoot, "test.log"))).toBe(false);

    await rename(workspace, backup);
    result = await runShell(command());
    expect(result.statusCode).toBe(0);
    expect(result.stdout.trim()).toBe("reused");
    expect(await pathExists(backup)).toBe(false);
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe("hello\n");

    await mkdir(backup);
    result = await runShell(command());
    expect(result.statusCode).toBe(0);
    expect(result.stdout.trim()).toBe("reused");
    expect(await pathExists(backup)).toBe(false);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
  }
});

test("preserves a non-empty interrupted workspace backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-swe-repository-backup-test-"));
  try {
    const workspace = join(root, "workspace");
    const stagingRoot = join(root, "staging");
    const backup = join(root, "workspace-backup");
    await mkdir(backup);
    await writeFile(join(backup, "keep-me.txt"), "preserve me\n");
    const command = buildRepositoryCheckoutCommand(
      "backup",
      "/unused-remote",
      null,
      60_000,
      4_294_967_296,
      1,
      { workspacePath: workspace, stagingRoot, workspaceBackupPath: backup },
    );

    const result = await runShell(command);
    expect(result.statusCode).not.toBe(0);
    expect(await readFile(join(workspace, "keep-me.txt"), "utf8")).toBe("preserve me\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes an oversized clone staging directory", async () => {
  const repository = await localBareRepository();
  try {
    const workspace = join(repository.root, "workspace");
    const stagingRoot = join(repository.root, "staging");
    const backup = join(repository.root, "workspace-backup");
    const command = buildRepositoryCheckoutCommand(
      "oversized",
      repository.remote,
      null,
      60_000,
      1,
      1,
      { workspacePath: workspace, stagingRoot, workspaceBackupPath: backup },
    );
    const result = await runShell(command);
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
    const backup = join(repository.root, "workspace-backup");
    const bin = join(repository.root, "bin");
    const dfState = join(repository.root, "df-count");
    await mkdir(bin);
    const realDf = (await runShell("command -v df")).stdout.trim();
    const realGit = (await runShell("command -v git")).stdout.trim();
    await writeFile(
      join(bin, "df"),
      [
        "#!/bin/sh",
        "state='" + dfState + "'",
        "count=0",
        'if [ -f "$state" ]; then count=$(cat "$state"); fi',
        "count=$((count + 1))",
        'printf \'%s\\n\' "$count" >"$state"',
        'if [ "$count" -ge 3 ]; then',
        "  printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'",
        "  printf 'fake 100 100 0 100%% %s\\n' \"$1\"",
        "else",
        "  exec '" + realDf + '\' "$@"',
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
        "    exec '" + realGit + '\' "$@"',
        "  fi",
        "done",
        "exec '" + realGit + '\' "$@"',
        "",
      ].join("\n"),
    );
    await chmod(join(bin, "git"), 0o755);
    const command = buildRepositoryCheckoutCommand(
      "promotion-space",
      repository.remote,
      null,
      60_000,
      4_294_967_296,
      1,
      { workspacePath: workspace, stagingRoot, workspaceBackupPath: backup },
    );
    const result = await runShell(command, { PATH: `${bin}:${process.env.PATH ?? ""}` });
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
    const backup = join(root, "workspace-backup");
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
    const command = buildRepositoryCheckoutCommand(
      "timeout",
      "/unused-remote",
      null,
      1_000,
      4_294_967_296,
      1,
      { workspacePath: workspace, stagingRoot, workspaceBackupPath: backup },
    );
    const result = await runShell(command, { PATH: `${bin}:${process.env.PATH ?? ""}` });
    expect(result.statusCode).toBe(124);
    expect(await pathExists(join(stagingRoot, "timeout.staging"))).toBe(false);
    expect(await pathExists(join(stagingRoot, "timeout.log"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps monitoring a clone while its process group is starting", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-swe-repository-process-group-test-"));
  try {
    const workspace = join(root, "workspace");
    const stagingRoot = join(root, "staging");
    const backup = join(root, "workspace-backup");
    const bin = join(root, "bin");
    const descendantPid = join(root, "descendant.pid");
    await mkdir(bin);
    await writeFile(
      join(bin, "setsid"),
      [
        "#!/bin/sh",
        "exec python3 - \"$@\" <<'PY'",
        "import os",
        "import sys",
        "import time",
        "",
        "args = sys.argv[1:]",
        'if args[0] == "--wait":',
        "    args = args[1:]",
        "time.sleep(0.5)",
        "os.setpgid(0, 0)",
        "os.execvp(args[0], args)",
        "PY",
        "",
      ].join("\n"),
    );
    await chmod(join(bin, "setsid"), 0o755);
    await writeFile(
      join(bin, "git"),
      [
        "#!/bin/sh",
        'for arg in "$@"; do',
        '  if [ "$arg" = "clone" ]; then',
        "    exec python3 - <<'PY'",
        "import os",
        "import subprocess",
        "import time",
        "",
        'child = subprocess.Popen(["python3", "-c", "import time; time.sleep(30)"])',
        'with open(os.environ["DESCENDANT_PID_FILE"], "w") as pid_file:',
        "    pid_file.write(str(child.pid))",
        "time.sleep(5)",
        "child.terminate()",
        "child.wait()",
        "raise SystemExit(128)",
        "PY",
        "  fi",
        "done",
        "exit 128",
        "",
      ].join("\n"),
    );
    await chmod(join(bin, "git"), 0o755);
    const command = buildRepositoryCheckoutCommand(
      "process-group",
      "/unused-remote",
      null,
      2_000,
      4_294_967_296,
      1,
      { workspacePath: workspace, stagingRoot, workspaceBackupPath: backup },
    );
    const result = await runPosixShell(command, {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      DESCENDANT_PID_FILE: descendantPid,
    });
    expect(result.statusCode).toBe(124);
    expect(await pathExists(join(stagingRoot, "process-group.staging"))).toBe(false);
    expect(await pathExists(join(stagingRoot, "process-group.log"))).toBe(false);
    expect(await pathExists(descendantPid)).toBe(true);
    const descendant = (await readFile(descendantPid, "utf8")).trim();
    const descendantStatus = await runProcess("kill", ["-0", descendant]);
    expect(descendantStatus.statusCode).not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
