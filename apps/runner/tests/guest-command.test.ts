import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "bun:test";
import {
  buildGuestCommandRequest,
  buildGuestReconcileRequest,
  parseGuestCommandObservation,
  type GuestCommandOwner,
} from "../src/guest-command.js";
import { processResult } from "../src/sandbox.js";

function owner(workspaceId: string = randomUUID()): GuestCommandOwner {
  return {
    commandId: randomUUID(),
    workspace: {
      id: workspaceId,
      threadId: randomUUID(),
      name: `cloud-swe-${workspaceId}`,
      provider: "docker",
      providerId: `cloud-swe-${workspaceId}`,
      generation: 1,
    },
    runId: randomUUID(),
    attemptId: "attempt-1",
  };
}

async function runProcess(
  command: string,
  args: string[],
  options: { input?: string; timeoutMs?: number } = {},
): Promise<{ statusCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 30_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (statusCode) => {
      clearTimeout(timer);
      resolve({ statusCode: statusCode ?? 1, stdout, stderr });
    });
    child.stdin.end(options.input ?? "");
  });
}

const dockerAvailable = await (async () => {
  try {
    return (await runProcess("docker", ["info"], { timeoutMs: 8_000 })).statusCode === 0;
  } catch {
    return false;
  }
})();

async function withGuestHost(work: (container: string) => Promise<void>): Promise<void> {
  const container = `cloud-swe-guest-${randomUUID()}`;

  const started = await runProcess("docker", [
    "run",
    "-d",
    "--name",
    container,
    "ubuntu:24.04",
    "sleep",
    "infinity",
  ]);

  expect(started.statusCode, started.stderr).toBe(0);

  try {
    await work(container);
  } finally {
    await runProcess("docker", ["rm", "-f", container], { timeoutMs: 15_000 });
  }
}

async function runFenced(
  container: string,
  current: GuestCommandOwner,
  request: { command: string; stdin?: string; timeoutMs?: number },
  outputMaxBytes = 65_536,
) {
  const fenced = buildGuestCommandRequest({ owner: current, request, outputMaxBytes });

  const result = await runProcess(
    "docker",
    ["exec", "-i", container, "sh", "-lc", fenced.command],
    { input: fenced.stdin, timeoutMs: (fenced.timeoutMs ?? 30_000) + 20_000 },
  );

  return {
    observation: parseGuestCommandObservation(
      processResult(result.stdout, result.stderr, result.statusCode),
      current,
    ),
    raw: result,
  };
}

async function guestStat(
  container: string,
  current: GuestCommandOwner,
  file: string,
): Promise<number> {
  const path = `/tmp/cloud-swe-commands/${current.workspace.id}/${current.commandId}/${file}`;
  const result = await runProcess("docker", ["exec", container, "sh", "-lc", `wc -c < ${path}`]);

  return Number.parseInt(result.stdout.trim(), 10);
}

test("fenced request uses stdin channel and does not embed a large payload in argv", () => {
  const current = owner();
  const stdin = "x".repeat(200_000);

  const fenced = buildGuestCommandRequest({
    owner: current,
    request: { command: "cat", stdin, timeoutMs: 5_000 },
    outputMaxBytes: 4_096,
  });

  expect(fenced.stdin).toBe(stdin);
  expect(fenced.command.includes('cat >"$dir/stdin"')).toBe(true);
  expect(fenced.command.includes(Buffer.from(stdin, "utf8").toString("base64"))).toBe(false);
  expect(Buffer.byteLength(fenced.command, "utf8")).toBeLessThan(128 * 1024);
  expect(fenced.command.includes("9>&-")).toBe(true);
  expect(fenced.command.includes("inner-exit")).toBe(true);
  expect(fenced.command.includes("drain_stream")).toBe(true);
  expect(fenced.command.includes("cat >/dev/null")).toBe(true);
  expect(fenced.command.includes("__CLOUD_SWE_STDOUT_BEGIN__")).toBe(true);
  expect(fenced.command.includes("Do not wait for or kill drain readers")).toBe(true);
  expect(fenced.command.includes("--foreground")).toBe(false);
  expect(fenced.command.includes("timeout --kill-after=5s")).toBe(true);
  expect(fenced.command.includes("command -v stdbuf")).toBe(true);
  expect(fenced.command.includes(': >"$dir/stdout.capture"')).toBe(false);
  expect(fenced.command.includes('[ ! -f "$capture" ]')).toBe(true);
  expect(fenced.command.includes("exec 9>&-\n  emit_result")).toBe(true);
});

test("settled status without output sections does not claim available output", () => {
  const current = owner();

  const observation = parseGuestCommandObservation(
    processResult(`__CLOUD_SWE_RESULT__${current.commandId}\tcompleted\t0\t0\t0\n`, "", 0),
    current,
  );

  expect(observation.state).toBe("completed");
  expect(observation.outputAvailable).toBe(false);
});

test("settled status with output sections is available without reconcile", () => {
  const current = owner();

  const observation = parseGuestCommandObservation(
    processResult(
      [
        `__CLOUD_SWE_RESULT__${current.commandId}\tcompleted\t0\t0\t0`,
        `__CLOUD_SWE_STDOUT_BEGIN__${current.commandId}`,
        "hello",
        `__CLOUD_SWE_STDOUT_END__${current.commandId}`,
        `__CLOUD_SWE_STDERR_BEGIN__${current.commandId}`,
        "",
        `__CLOUD_SWE_STDERR_END__${current.commandId}`,
        "",
      ].join("\n"),
      "",
      0,
    ),
    current,
  );

  expect(observation.outputAvailable).toBe(true);
  expect(observation.stdout).toBe("hello");
});

test.skipIf(!dockerAvailable)(
  "unredirected background child does not hold the lock or block a second command",
  async () => {
    await withGuestHost(async (container) => {
      const workspaceId = randomUUID();
      const first = owner(workspaceId);

      const started = await runFenced(
        container,
        first,
        {
          command: "printf 'parent-out\\n'; sleep 60 &",
          timeoutMs: 8_000,
        },
        4_096,
      );

      expect(started.observation.state).toBe("completed");
      expect(started.observation.outputAvailable).toBe(true);
      expect(started.observation.stdout).toContain("parent-out");

      const second = owner(workspaceId);

      const follow = await runFenced(
        container,
        second,
        { command: "printf second\\n", timeoutMs: 8_000 },
        4_096,
      );

      expect(follow.observation.state, follow.raw.stderr).toBe("completed");
      expect(follow.observation.stdout).toContain("second");
    });
  },
  90_000,
);

test.skipIf(!dockerAvailable)(
  "redirected daemon does not hold the lock or block a second command",
  async () => {
    await withGuestHost(async (container) => {
      const workspaceId = randomUUID();
      const first = owner(workspaceId);

      const started = await runFenced(
        container,
        first,
        {
          command: "printf 'parent-out\\n'; nohup sleep 60 >/dev/null 2>&1 &",
          timeoutMs: 8_000,
        },
        4_096,
      );

      expect(started.observation.state).toBe("completed");
      expect(started.observation.stdout).toContain("parent-out");

      const second = owner(workspaceId);

      const follow = await runFenced(
        container,
        second,
        { command: "printf second\\n", timeoutMs: 8_000 },
        4_096,
      );

      expect(follow.observation.state, follow.raw.stderr).toBe("completed");
      expect(follow.observation.stdout).toContain("second");
    });
  },
  90_000,
);

test.skipIf(!dockerAvailable)(
  "background yes stays alive and journal files stay bounded",
  async () => {
    await withGuestHost(async (container) => {
      const current = owner();
      const outputMaxBytes = 64;
      const stdoutLimit = Math.floor(outputMaxBytes / 2);

      const started = await runFenced(
        container,
        current,
        { command: "printf 'parent-out\\n'; yes &", timeoutMs: 8_000 },
        outputMaxBytes,
      );

      expect(started.observation.state).toBe("completed");
      expect(started.observation.stdout).toContain("parent-out");
      expect(started.observation.outputTruncated).toBe(true);

      const stdoutBytes = await guestStat(container, current, "stdout");
      const captureBytes = await guestStat(container, current, "stdout.capture");
      expect(stdoutBytes).toBeLessThanOrEqual(stdoutLimit);
      expect(captureBytes).toBeLessThanOrEqual(stdoutLimit + 1);

      await Bun.sleep(400);
      expect(await guestStat(container, current, "stdout")).toBeLessThanOrEqual(stdoutLimit);
      expect(await guestStat(container, current, "stdout.capture")).toBeLessThanOrEqual(
        stdoutLimit + 1,
      );

      const yes = await runProcess("docker", ["exec", container, "sh", "-lc", "pgrep -x yes"]);
      expect(yes.statusCode, "yes should still be running; readers must not SIGPIPE it").toBe(0);

      const follow = owner(current.workspace.id);

      const second = await runFenced(
        container,
        follow,
        { command: "printf second\\n", timeoutMs: 8_000 },
        4_096,
      );

      expect(second.observation.state).toBe("completed");
      expect(second.observation.stdout).toContain("second");
    });
  },
  90_000,
);

test.skipIf(!dockerAvailable)(
  "large stdin arrives on the channel and user exit 124 is not a timeout",
  async () => {
    await withGuestHost(async (container) => {
      const current = owner();
      const stdin = `${"payload-".repeat(24_000)}\n`;

      const written = await runFenced(container, current, {
        command: "wc -c",
        stdin,
        timeoutMs: 10_000,
      });

      expect(written.observation.state).toBe("completed");
      expect(written.observation.stdout.trim()).toBe(String(Buffer.byteLength(stdin, "utf8")));

      const timed = owner(current.workspace.id);

      const explicit = await runFenced(container, timed, {
        command: "exit 124",
        timeoutMs: 10_000,
      });

      expect(explicit.observation.state).toBe("failed");
      expect(explicit.observation.timedOut).toBe(false);
      expect(explicit.observation.statusCode).toBe(124);

      const hung = owner(current.workspace.id);
      const timeout = await runFenced(container, hung, { command: "sleep 60", timeoutMs: 1_000 });
      expect(timeout.observation.timedOut).toBe(true);
      expect(timeout.observation.state).toBe("failed");
      expect(timeout.observation.statusCode).toBe(124);

      const leftover = await runProcess("docker", [
        "exec",
        container,
        "sh",
        "-lc",
        "pgrep -f '^sleep 60$' || true",
      ]);

      expect(
        leftover.stdout.trim(),
        "timed-out foreground sleep must be process-group killed",
      ).toBe("");
    });
  },
  90_000,
);

test("reconcile request is read-only and compares metadata with cmp", () => {
  const current = owner();
  const request = buildGuestReconcileRequest({ owner: current, timeoutMs: 3_000 });
  expect(request.command.includes("command.sh")).toBe(false);
  expect(request.command.includes("cmp -s")).toBe(true);
});
