import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "bun:test";
import pino from "pino";
import { loadRunnerConfig } from "../src/config.js";
import { createDockerProvider } from "../src/docker.js";
import type { WorkspaceRef } from "../src/sandbox.js";

async function dockerInfoOk(): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn("docker", ["info"], { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, 8_000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      resolve(status === 0);
    });
  });
}

const dockerAvailable = await dockerInfoOk();

function workspace(): WorkspaceRef {
  const id = randomUUID();
  return {
    id,
    threadId: randomUUID(),
    name: `cloud-swe-${id}`,
    provider: "docker",
    providerId: null,
    generation: 1,
  };
}

test.skipIf(!dockerAvailable)(
  "missing resolve and pause share one providerTimeout and do not stack full deadlines",
  async () => {
    const provider = createDockerProvider(
      { ...loadRunnerConfig(), providerTimeoutMs: 5_000 },
      pino({ enabled: false }),
    );
    const current = workspace();
    const started = Date.now();
    const resolved = await provider.resolve(current, AbortSignal.timeout(5_000));
    expect(resolved.disposition).toBe("missing");
    const paused = await provider.pause(current, AbortSignal.timeout(5_000));
    expect(paused.outcome).toBe("missing");
    expect(Date.now() - started).toBeLessThan(5_000);
  },
);
