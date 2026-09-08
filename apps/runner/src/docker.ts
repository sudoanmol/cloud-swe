import { spawn } from "node:child_process";
import { env } from "@cloud-swe/env/runner";
import type { Logger } from "pino";
import { z } from "zod";
import type { CommandRequest, CommandResult, SandboxProvider, WorkspaceRef } from "./sandbox.js";
import { workspaceRef } from "./sandbox.js";

const containerState = z.array(
  z.object({
    State: z.object({ Status: z.string() }),
    Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }),
  }),
);
const managedLabel = "cloud-swe.managed";
const nameSchema = z.string().regex(/^cloud-swe-[0-9a-f-]{36}$/);

export type { SandboxProvider } from "./sandbox.js";

export function createDockerProvider(logger: Logger): SandboxProvider {
  const image = env.RUNNER_DOCKER_IMAGE;

  async function docker(
    args: string[],
    signal: AbortSignal,
    input?: string,
  ): Promise<CommandResult> {
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
      child.stdin.on("error", () => undefined);
      child.once("error", (error) => {
        failure = error;
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else resolve({ stdout, stderr, statusCode: code });
      });
      child.stdin.end(input);
    });
  }

  async function checked(args: string[], signal: AbortSignal, input?: string): Promise<string> {
    const result = await docker(args, signal, input);
    if (result.statusCode !== 0)
      throw new Error((result.stderr || "Docker command failed").slice(0, 500));
    return result.stdout.trim();
  }

  async function inspect(name: string, signal: AbortSignal): Promise<string | null> {
    nameSchema.parse(name);
    const ids = await checked(
      ["container", "ls", "-a", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"],
      signal,
    );
    if (!ids) return null;
    const [state] = containerState.parse(JSON.parse(await checked(["inspect", name], signal)));
    if (!state || state.Config.Labels?.[managedLabel] !== "true")
      throw new Error("Refusing to operate an unmanaged container");
    return state.State.Status;
  }

  async function execute(
    workspace: WorkspaceRef | string,
    request: CommandRequest | string,
    signal: AbortSignal,
  ): Promise<CommandResult> {
    const name = workspaceRef(workspace).name;
    nameSchema.parse(name);
    const commandRequest: CommandRequest =
      typeof request === "string" ? { command: request } : request;
    const timeoutMs = commandRequest.timeoutMs ?? 20_000;
    const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    return docker(
      [
        "exec",
        "-i",
        name,
        "timeout",
        `${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
        "sh",
        "-lc",
        commandRequest.command,
      ],
      operationSignal,
      commandRequest.stdin,
    );
  }

  return {
    async ensure(workspace, signal) {
      const name = workspaceRef(workspace).name;
      let state = await inspect(name, signal);
      if (state === null) {
        await checked(
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
      if (state === "paused") await checked(["unpause", name], signal);
      else if (state !== "running") await checked(["start", name], signal);
      return { providerId: name };
    },
    async exec(workspace, request, signal) {
      return execute(workspace, request, signal);
    },
    async execStep(workspace, runId, prompt, signal) {
      const name = workspaceRef(workspace).name;
      nameSchema.parse(name);
      z.uuid().parse(runId);
      const script =
        'mkdir -p "/workspace/runs/$1" && cat > "/workspace/runs/$1/prompt.txt" && printf "scripted runner completed\\n" > "/workspace/runs/$1/result.txt" && cat "/workspace/runs/$1/result.txt"';
      const result = await execute(
        workspace,
        {
          command: `timeout 10 flock --no-fork /tmp/cloud-swe-script.lock sh -c '${script}' runner-step '${runId}'`,
          stdin: prompt,
          timeoutMs: 20_000,
        },
        signal,
      );
      if (result.statusCode !== 0)
        throw new Error((result.stderr || "Docker command failed").slice(0, 500));
      signal.throwIfAborted();
      logger.info({ sandbox: name, runId }, "Scripted sandbox step completed");
      return result.stdout.trim();
    },
    async pause(workspace, signal) {
      const name = workspaceRef(workspace).name;
      const state = await inspect(name, signal);
      if (state === null) return false;
      if (state !== "running" && state !== "paused") await checked(["start", name], signal);
      if (state !== "paused") await checked(["pause", name], signal);
      return true;
    },
    async delete(workspace, signal) {
      const name = workspaceRef(workspace).name;
      if ((await inspect(name, signal)) !== null) await checked(["rm", "-f", name], signal);
    },
  };
}
