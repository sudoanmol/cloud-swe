import { Freestyle, FreestyleApiError } from "freestyle";
import type { Logger } from "pino";
import { z } from "zod";
import { env } from "@cloud-swe/env/runner";
import type { CommandRequest, CommandResult, SandboxProvider, WorkspaceRef } from "./sandbox.js";
import { workspaceRef } from "./sandbox.js";

const defaultTimeoutMs = 20_000;
const maxTimeoutMs = 300_000;

function isMissingVm(error: unknown): boolean {
  return error instanceof FreestyleApiError && error.status === 404;
}

function safeSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (slug || "cloud-swe-workspace").slice(0, 63).replace(/-$/, "") || "cloud-swe-workspace";
}

function safeDisplayName(name: string): string {
  return name.replace(/[^a-zA-Z0-9 ._-]+/g, "-").slice(0, 63) || "cloud-swe workspace";
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let interrupted = false;
  const onAbort = () => {
    // Freestyle exec requests can continue in the guest after the client call
    // is abandoned. Wait for the bounded request to settle before releasing
    // the workspace lock so another run cannot overlap the guest mutation.
    interrupted = true;
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const value = await operation;
    if (interrupted) throw new Error("Sandbox operation interrupted");
    return value;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function createFreestyleProvider(logger: Logger): SandboxProvider {
  const client = new Freestyle({ apiKey: env.FREESTYLE_API_KEY });

  async function vmFor(workspace: WorkspaceRef | string) {
    const ref = workspaceRef(workspace);
    if (!ref.providerId) throw new Error(`Workspace ${ref.name} has no Freestyle VM id`);
    return { ref, vm: client.vms.ref(ref.providerId) };
  }

  async function exec(
    workspace: WorkspaceRef | string,
    request: CommandRequest | string,
    signal: AbortSignal,
  ): Promise<CommandResult> {
    const { vm } = await vmFor(workspace);
    const commandRequest: CommandRequest =
      typeof request === "string" ? { command: request } : request;
    const timeoutMs = Math.min(
      Math.max(commandRequest.timeoutMs ?? defaultTimeoutMs, 1),
      maxTimeoutMs,
    );
    const result = await abortable(
      vm.exec({
        command: commandRequest.command,
        stdin: commandRequest.stdin
          ? Buffer.from(commandRequest.stdin, "utf8").toString("base64")
          : undefined,
        timeoutMs,
      }),
      signal,
    );
    signal.throwIfAborted();
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      statusCode: result.statusCode ?? null,
    };
  }

  return {
    async ensure(workspace, signal) {
      const ref = workspaceRef(workspace);
      if (ref.providerId) {
        const vm = client.vms.ref(ref.providerId);
        try {
          const data = await abortable(vm.data(), signal);
          if (data.state === "paused" || data.state === "stopped")
            await abortable(vm.start(), signal);
          return { providerId: ref.providerId };
        } catch (error) {
          if (!isMissingVm(error)) throw error;
        }
      }

      const slug = safeSlug(ref.name);
      const findExisting = async (lookupSignal: AbortSignal, startIfStopped: boolean) => {
        try {
          const existing = await abortable(client.vms.get(slug), lookupSignal);
          if (
            existing.metadata["cloud-swe-managed"] !== "true" ||
            existing.metadata["cloud-swe-workspace"] !== slug
          )
            throw new Error(`Refusing to adopt unmanaged Freestyle VM with slug ${slug}`);
          if (startIfStopped && (existing.state === "paused" || existing.state === "stopped"))
            await abortable(client.vms.ref(existing.id).start(), lookupSignal);
          return { providerId: existing.id };
        } catch (error) {
          if (isMissingVm(error)) return undefined;
          throw error;
        }
      };
      const recovered = await findExisting(signal, true);
      if (recovered) return recovered;

      let created: Awaited<ReturnType<typeof client.vms.create>>;
      try {
        created = await abortable(
          client.vms.create({
            snapshotId: env.FREESTYLE_SNAPSHOT_ID,
            slug,
            displayName: safeDisplayName(ref.name),
            idleTimeoutSeconds: env.FREESTYLE_IDLE_TIMEOUT_SECONDS,
            autoDeleteSeconds: env.FREESTYLE_AUTO_DELETE_SECONDS,
            metadata: { "cloud-swe-managed": "true", "cloud-swe-workspace": slug },
            firewall: {
              rules: [{ action: "allow", source: {}, destination: { public: true } }],
            },
          }),
          signal,
        );
      } catch (error) {
        // A cancelled request may have created the VM after the client stopped
        // waiting. Reconcile by slug before allowing a retry or cleanup to run.
        const reconcileSignal = AbortSignal.timeout(defaultTimeoutMs);
        const reconciled = await findExisting(reconcileSignal, false);
        if (reconciled) {
          logger.warn(
            { sandbox: ref.name, providerId: reconciled.providerId },
            "Reconciled Freestyle sandbox after an interrupted create",
          );
          return reconciled;
        }
        throw error;
      }
      logger.info({ sandbox: ref.name, providerId: created.vmId }, "Freestyle sandbox ready");
      return { providerId: created.vmId };
    },
    async exec(workspace, request, signal) {
      return exec(workspace, request, signal);
    },
    async execStep(workspace, runId, prompt, signal) {
      const ref = workspaceRef(workspace);
      z.uuid().parse(runId);
      const result = await exec(
        workspace,
        {
          command: `mkdir -p /workspace/runs/${runId} && cat > /workspace/runs/${runId}/prompt.txt && printf 'scripted runner completed\\n' > /workspace/runs/${runId}/result.txt && cat /workspace/runs/${runId}/result.txt`,
          stdin: prompt,
          timeoutMs: defaultTimeoutMs,
        },
        signal,
      );
      if (result.statusCode !== 0)
        throw new Error((result.stderr || "Freestyle command failed").slice(0, 500));
      logger.info({ sandbox: ref.name, runId }, "Freestyle sandbox step completed");
      return result.stdout.trim();
    },
    async pause(workspace, signal) {
      if (!workspaceRef(workspace).providerId) return false;
      const { vm } = await vmFor(workspace);
      try {
        const data = await abortable(vm.data(), signal);
        if (data.state === "running") await abortable(vm.pause(), signal);
        return true;
      } catch (error) {
        if (isMissingVm(error)) return false;
        throw error;
      }
    },
    async delete(workspace, signal) {
      if (!workspaceRef(workspace).providerId) return;
      const { ref, vm } = await vmFor(workspace);
      try {
        await abortable(vm.delete(), signal);
        logger.info({ sandbox: ref.name, providerId: ref.providerId }, "Freestyle sandbox deleted");
      } catch (error) {
        if (!isMissingVm(error)) throw error;
      }
    },
  };
}
