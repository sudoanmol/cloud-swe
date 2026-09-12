import { boundedUtf8 } from "./text.js";
import { spawn } from "node:child_process";
import type { Logger } from "pino";
import { z } from "zod";
import type { RunnerConfig } from "./config.js";
import {
  assertWorkspaceProvider,
  isProcessResult,
  processResult,
  providerOutputMaxBytes,
  providerTimeoutMs,
  remainingProviderTimeoutMs,
  SandboxProviderError,
  transportResult,
  withProviderBudget,
  type CommandRequest,
  type CommandResult,
  type LifecycleResult,
  type SandboxProvider,
  type WorkspaceRef,
} from "./sandbox.js";

const containerState = z.array(
  z.object({
    State: z.object({ Status: z.string() }),
    Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }),
  }),
);

const managedLabel = "cloud-swe.managed";

const nameSchema = z.string().regex(/^cloud-swe-[0-9a-f-]{36}$/);

const commandGraceMs = 5_000;

export type { SandboxProvider } from "./sandbox.js";

function appendBounded(current: string, chunk: string, available: number) {
  const bounded = boundedUtf8(chunk, Math.max(0, available));

  return { value: current + bounded.text, truncated: bounded.truncated };
}

function isProviderInterruption(error: unknown): error is SandboxProviderError {
  return error instanceof SandboxProviderError;
}

export function createDockerProvider(config: RunnerConfig, logger: Logger): SandboxProvider {
  const image = config.dockerImage;
  const outputLimit = providerOutputMaxBytes(config);
  const providerDeadline = providerTimeoutMs(config);

  async function docker(
    args: string[],
    signal: AbortSignal,
    options: { timeoutMs?: number; input?: string } = {},
  ): Promise<CommandResult> {
    if (signal.aborted) return transportResult("cancelled", "Docker process cancelled");
    const timeoutMs = Math.max(1, options.timeoutMs ?? providerDeadline);

    return await new Promise<CommandResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let interrupted: "transport-timeout" | "cancelled" | "output-limit" | "unknown" | undefined;
      let child: ReturnType<typeof spawn>;

      try {
        child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
      } catch {
        resolve(transportResult("unknown", "Docker process could not be started"));

        return;
      }

      const deadline = setTimeout(() => {
        interrupted = "transport-timeout";
        child.kill("SIGKILL");
      }, timeoutMs);

      const abort = () => {
        interrupted = "cancelled";
        child.kill("SIGKILL");
      };

      signal.addEventListener("abort", abort, { once: true });

      const capture = (chunk: string, target: "stdout" | "stderr") => {
        if (interrupted) return;
        const current = target === "stdout" ? stdout : stderr;
        const used = Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8");
        const next = appendBounded(current, chunk, outputLimit - used);

        if (target === "stdout") stdout = next.value;
        else stderr = next.value;

        if (next.truncated) {
          interrupted = "output-limit";
          child.kill("SIGKILL");
        }
      };

      if (!child.stdout || !child.stderr || !child.stdin) {
        clearTimeout(deadline);
        signal.removeEventListener("abort", abort);
        child.kill("SIGKILL");
        resolve(transportResult("unknown", "Docker process streams unavailable"));

        return;
      }

      const stdin = child.stdin;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => capture(chunk, "stdout"));
      child.stderr.on("data", (chunk: string) => capture(chunk, "stderr"));
      stdin.on("error", () => undefined);
      child.once("error", () => {
        if (!interrupted) {
          interrupted = "unknown";
          stderr = appendBounded(stderr, "Docker process failed", outputLimit).value;
        }
      });
      child.once("close", (statusCode) => {
        clearTimeout(deadline);
        signal.removeEventListener("abort", abort);

        if (interrupted) {
          resolve(
            transportResult(
              interrupted,
              stderr || undefined,
              stdout,
              stderr,
              interrupted === "output-limit",
            ),
          );

          return;
        }

        if (statusCode === null) {
          resolve(
            transportResult(
              "unknown",
              "Docker process ended without an exit status",
              stdout,
              stderr,
            ),
          );

          return;
        }

        resolve(processResult(stdout, stderr, statusCode, false));
      });

      if (options.input !== undefined) stdin.end(options.input);
      else stdin.end();
    });
  }

  async function checked(
    args: string[],
    signal: AbortSignal,
    options: { timeoutMs?: number; input?: string } = {},
  ): Promise<string> {
    const result = await docker(args, signal, options);

    if (result.kind !== "completed") {
      const detail = isProcessResult(result)
        ? `Docker operation returned ${result.kind}`
        : (result.error ?? `Docker operation returned ${result.kind}`);

      throw new SandboxProviderError(
        result.kind === "transport-timeout"
          ? "timeout"
          : result.kind === "cancelled"
            ? "cancelled"
            : "unknown",
        `docker ${args[0] ?? "operation"}`,
        detail,
        { cause: new Error(detail) },
      );
    }

    return result.stdout.trim();
  }

  function lifecycleBudget(signal: AbortSignal) {
    return {
      signal: withProviderBudget(signal, providerDeadline),
      deadline: Date.now() + providerDeadline,
    };
  }

  async function inspect(
    workspace: WorkspaceRef,
    signal: AbortSignal,
    deadline: number,
  ): Promise<{ status: string; providerId: string } | null> {
    assertWorkspaceProvider(workspace, "docker");
    const name = nameSchema.parse(workspace.name);

    const ids = await checked(
      ["container", "ls", "-a", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"],
      signal,
      { timeoutMs: remainingProviderTimeoutMs(deadline) },
    );

    if (!ids) return null;

    const [state] = containerState.parse(
      JSON.parse(
        await checked(["inspect", name], signal, {
          timeoutMs: remainingProviderTimeoutMs(deadline),
        }),
      ),
    );

    if (!state || state.Config.Labels?.[managedLabel] !== "true")
      throw new Error("Refusing to operate an unmanaged Docker container");
    const workspaceLabel = state.Config.Labels?.["cloud-swe.workspace"];

    if (workspaceLabel && workspaceLabel !== workspace.id)
      throw new Error("Refusing to operate a Docker container for another workspace");

    return { status: state.State.Status, providerId: name };
  }

  async function execute(
    workspace: WorkspaceRef,
    request: CommandRequest,
    signal: AbortSignal,
  ): Promise<CommandResult> {
    assertWorkspaceProvider(workspace, "docker");
    const name = nameSchema.parse(workspace.name);
    const timeoutMs = Math.max(1, request.timeoutMs ?? providerDeadline);

    return await docker(["exec", "-i", name, "sh", "-lc", request.command], signal, {
      timeoutMs: timeoutMs + commandGraceMs,
      input: request.stdin,
    });
  }

  async function lifecycle(
    workspace: WorkspaceRef,
    action: "pause" | "delete",
    signal: AbortSignal,
  ): Promise<LifecycleResult> {
    assertWorkspaceProvider(workspace, "docker");
    const budget = lifecycleBudget(signal);

    try {
      const found = await inspect(workspace, budget.signal, budget.deadline);

      if (!found) return { action, outcome: "missing", providerId: null, recovered: false };

      if (action === "pause") {
        if (found.status !== "paused") {
          if (found.status !== "running")
            await checked(["start", found.providerId], budget.signal, {
              timeoutMs: remainingProviderTimeoutMs(budget.deadline),
            });
          await checked(["pause", found.providerId], budget.signal, {
            timeoutMs: remainingProviderTimeoutMs(budget.deadline),
          });
        }
      } else
        await checked(["rm", "-f", found.providerId], budget.signal, {
          timeoutMs: remainingProviderTimeoutMs(budget.deadline),
        });

      return {
        action,
        outcome: "completed",
        providerId: found.providerId,
        recovered: workspace.providerId === null,
      };
    } catch (error) {
      if (isProviderInterruption(error)) {
        logger.warn(
          { workspaceId: workspace.id, action, kind: error.kind },
          "Docker lifecycle unknown",
        );

        return {
          action,
          outcome: "unknown",
          providerId: workspace.providerId,
          recovered: false,
        };
      }

      throw error;
    }
  }

  return {
    async resolve(workspace, signal) {
      assertWorkspaceProvider(workspace, "docker");
      const budget = lifecycleBudget(signal);
      const found = await inspect(workspace, budget.signal, budget.deadline);

      if (!found)
        return {
          workspace: { ...workspace, providerId: null },
          disposition: "missing",
          recovered: false,
        };

      return {
        workspace: { ...workspace, providerId: found.providerId },
        disposition: "present",
        recovered: workspace.providerId === null,
      };
    },
    async ensure(workspace, signal) {
      assertWorkspaceProvider(workspace, "docker");
      const budget = lifecycleBudget(signal);
      const name = nameSchema.parse(workspace.name);
      const found = await inspect(workspace, budget.signal, budget.deadline);

      if (!found) {
        await checked(
          [
            "create",
            "--name",
            name,
            "--label",
            `${managedLabel}=true`,
            "--label",
            `cloud-swe.workspace=${workspace.id}`,
            "--label",
            `cloud-swe.thread=${workspace.threadId}`,
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
          budget.signal,
          { timeoutMs: remainingProviderTimeoutMs(budget.deadline) },
        );
        await checked(["start", name], budget.signal, {
          timeoutMs: remainingProviderTimeoutMs(budget.deadline),
        });
        logger.info({ workspaceId: workspace.id, name }, "Docker sandbox created");

        return {
          providerId: name,
          disposition: workspace.providerId ? "replaced" : "created",
          previousProviderId: workspace.providerId || undefined,
          recovered: false,
        };
      }

      if (found.status === "paused")
        await checked(["unpause", name], budget.signal, {
          timeoutMs: remainingProviderTimeoutMs(budget.deadline),
        });
      else if (found.status !== "running")
        await checked(["start", name], budget.signal, {
          timeoutMs: remainingProviderTimeoutMs(budget.deadline),
        });

      return {
        providerId: name,
        disposition: "existing",
        recovered: workspace.providerId === null,
      };
    },
    async exec(workspace, request, signal) {
      return execute(workspace, request, signal);
    },
    async pause(workspace, signal) {
      return lifecycle(workspace, "pause", signal);
    },
    async delete(workspace, signal) {
      return lifecycle(workspace, "delete", signal);
    },
  };
}
