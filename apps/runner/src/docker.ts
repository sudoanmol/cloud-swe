import { spawn } from "node:child_process";
import type { Logger } from "pino";
import { z } from "zod";

const containerState = z.array(
  z.object({
    State: z.object({ Status: z.string() }),
    Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }),
  }),
);
const managedLabel = "cloud-swe.managed";
const nameSchema = z.string().regex(/^cloud-swe-[0-9a-f-]{36}$/);

export interface SandboxProvider {
  ensure(name: string, signal: AbortSignal): Promise<void>;
  execStep(name: string, runId: string, prompt: string, signal: AbortSignal): Promise<string>;
  pause(name: string, signal: AbortSignal): Promise<boolean>;
  delete(name: string, signal: AbortSignal): Promise<void>;
}

export function createDockerProvider(logger: Logger): SandboxProvider {
  const image =
    process.env.RUNNER_DOCKER_IMAGE ??
    "ubuntu:24.04@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517";
  async function docker(args: string[], signal: AbortSignal, input?: string): Promise<string> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let failure: Error | undefined;
      const abort = () => {
        failure = new Error("Docker operation interrupted");
        child.kill("SIGKILL");
      };
      const timeout = setTimeout(() => {
        failure = new Error("Docker operation timed out");
        child.kill("SIGKILL");
      }, 20_000);
      signal.addEventListener("abort", abort, { once: true });
      const capture = (chunk: string, target: "stdout" | "stderr") => {
        if (target === "stdout") stdout += chunk;
        else stderr += chunk;
        if (stdout.length + stderr.length > 256_000) {
          failure = new Error("Docker output exceeded limit");
          child.kill("SIGKILL");
        }
      };
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => capture(chunk, "stdout"));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => capture(chunk, "stderr"));
      child.stdin.on("error", () => {
        /* Process exit determines the operation result. */
      });
      child.once("error", (error) => {
        failure = error;
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else if (code === 0) resolve(stdout.trim());
        else reject(new Error((stderr || "Docker command failed").slice(0, 500)));
      });
      child.stdin.end(input);
    });
  }

  async function inspect(name: string, signal: AbortSignal): Promise<string | null> {
    nameSchema.parse(name);
    // A daemon failure must never be mistaken for an absent container.
    const ids = await docker(
      ["container", "ls", "-a", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"],
      signal,
    );
    if (!ids) return null;
    const [state] = containerState.parse(JSON.parse(await docker(["inspect", name], signal)));
    if (!state || state.Config.Labels?.[managedLabel] !== "true")
      throw new Error("Refusing to operate an unmanaged container");
    return state.State.Status;
  }

  return {
    async ensure(name, signal) {
      let state = await inspect(name, signal);
      if (state === null) {
        await docker(
          [
            "create",
            "--name",
            name,
            "--label",
            `${managedLabel}=true`,
            "--label",
            `cloud-swe.thread=${name.slice(10)}`,
            "--network",
            "none",
            "--cpus",
            "1",
            "--memory",
            "512m",
            "--memory-swap",
            "512m",
            "--pids-limit",
            "128",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--log-driver",
            "none",
            image,
            "sleep",
            "infinity",
          ],
          signal,
        );
        state = "created";
      }
      if (state === "paused") await docker(["unpause", name], signal);
      else if (state !== "running") await docker(["start", name], signal);
    },
    async execStep(name, runId, prompt, signal) {
      nameSchema.parse(name);
      z.uuid().parse(runId);
      // Prompt bytes only enter stdin. The fixed script repeats safely at the same run path.
      const script =
        'mkdir -p "/workspace/runs/$1" && cat > "/workspace/runs/$1/prompt.txt" && printf "scripted runner completed\\n" > "/workspace/runs/$1/result.txt" && cat "/workspace/runs/$1/result.txt"';
      signal.throwIfAborted();
      // The daemon-side lock survives a worker crash. Allow this bounded operation to
      // finish on cancellation; killing a Docker client does not cancel remote exec.
      const output = await docker(
        [
          "exec",
          "-i",
          name,
          "timeout",
          "10",
          "flock",
          "--no-fork",
          "/tmp/cloud-swe-script.lock",
          "sh",
          "-c",
          script,
          "runner-step",
          runId,
        ],
        AbortSignal.timeout(20_000),
        prompt,
      );
      signal.throwIfAborted();
      logger.info({ sandbox: name, runId }, "Scripted sandbox step completed");
      return output;
    },
    async pause(name, signal) {
      const state = await inspect(name, signal);
      if (state === null) return false;
      if (state !== "running" && state !== "paused") await docker(["start", name], signal);
      if (state !== "paused") await docker(["pause", name], signal);
      return true;
    },
    async delete(name, signal) {
      if ((await inspect(name, signal)) !== null) await docker(["rm", "-f", name], signal);
    },
  };
}
