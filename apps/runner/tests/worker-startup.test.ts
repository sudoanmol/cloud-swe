import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

test("failed native worker initialization releases workflow threads and exits", async () => {
  const child = spawn("node", ["--import", "tsx", "src/index.ts", "worker"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      RUNNER_EXECUTION_MODE: "scripted",
      RUNNER_SANDBOX_PROVIDER: "docker",
      TEMPORAL_NAMESPACE: `missing-${randomUUID()}`,
    },
    timeout: 10_000,
    killSignal: "SIGKILL",
    stdio: "ignore",
  });

  const [code, signal] = await once(child, "exit");
  expect(code).toBe(1);
  expect(signal).toBeNull();
}, 15_000);
