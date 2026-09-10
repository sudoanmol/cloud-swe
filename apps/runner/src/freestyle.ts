import { setTimeout as delay } from "node:timers/promises";
import { Freestyle, FreestyleApiError } from "freestyle";
import type { Logger } from "pino";
import type { RunnerConfig } from "./config.js";
import {
  assertWorkspaceProvider,
  boundedProviderCall,
  processResult,
  providerOutputMaxBytes,
  providerTimeoutMs,
  SandboxProviderError,
  transportResult,
  type CommandRequest,
  type CommandResult,
  type LifecycleResult,
  type SandboxProvider,
  type WorkspaceRef,
  type WorkspaceResolution,
} from "./sandbox.js";

const commandGraceMs = 5_000;
const managedLabel = "cloud-swe.managed";
const managedWorkspaceLabel = "cloud-swe.workspace";
const managedWorkspaceIdLabel = "cloud-swe.workspace-id";
const managedThreadIdLabel = "cloud-swe.thread-id";

export function isMissingVm(error: unknown): error is FreestyleApiError {
  return error instanceof FreestyleApiError && error.status === 404;
}

export function safeSlug(name: string): string {
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

function safePublicError(operation: string): Error {
  return new Error(`Freestyle ${operation} failed`);
}

function isInterruption(error: unknown): error is SandboxProviderError {
  return error instanceof SandboxProviderError;
}

function boundedOutput(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return { value, truncated: false };
  return { value: encoded.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

function validateManagedVm(
  data: { metadata: Record<string, string> },
  slug: string,
  workspace: WorkspaceRef,
): void {
  const metadata = data.metadata;
  if (metadata[managedLabel] !== "true" || metadata[managedWorkspaceLabel] !== slug)
    throw new Error("Refusing to operate an unmanaged Freestyle VM");
  if (metadata[managedWorkspaceIdLabel] && metadata[managedWorkspaceIdLabel] !== workspace.id)
    throw new Error("Refusing to operate a Freestyle VM for another workspace");
  if (metadata[managedThreadIdLabel] && metadata[managedThreadIdLabel] !== workspace.threadId)
    throw new Error("Refusing to operate a Freestyle VM for another thread");
}

function lifecycleUnknown(
  action: "pause" | "delete",
  workspace: WorkspaceRef,
  recovered: boolean,
): LifecycleResult {
  return {
    action,
    outcome: "unknown",
    providerId: workspace.providerId,
    recovered,
  };
}

export function createFreestyleProvider(config: RunnerConfig, logger: Logger): SandboxProvider {
  const apiKey = config.freestyleApiKey;
  if (!apiKey) throw new Error("FREESTYLE_API_KEY is required for the Freestyle provider");
  if (!Number.isFinite(config.freestyleAutoDeleteSeconds) || config.freestyleAutoDeleteSeconds <= 0)
    throw new Error("Freestyle workspaces require a finite positive auto-delete timeout");
  const client = new Freestyle({ apiKey });
  const timeoutMs = providerTimeoutMs(config);
  const outputLimit = providerOutputMaxBytes(config);

  async function dataById(id: string, signal: AbortSignal) {
    return await boundedProviderCall({
      operation: "VM lookup",
      signal,
      timeoutMs,
      call: () => client.vms.ref(id).data(),
    });
  }

  async function dataBySlug(slug: string, workspace: WorkspaceRef, signal: AbortSignal) {
    const data = await boundedProviderCall({
      operation: "VM slug lookup",
      signal,
      timeoutMs,
      call: () => client.vms.get(slug),
    });
    validateManagedVm(data, slug, workspace);
    return data;
  }

  async function resolveInternal(
    workspace: WorkspaceRef,
    signal: AbortSignal,
  ): Promise<WorkspaceResolution> {
    assertWorkspaceProvider(workspace, "freestyle");
    const slug = safeSlug(workspace.name);
    if (workspace.providerId) {
      try {
        const data = await dataById(workspace.providerId, signal);
        validateManagedVm(data, slug, workspace);
        return {
          workspace: { ...workspace, providerId: data.id },
          disposition: "present",
          recovered: false,
        };
      } catch (error) {
        if (!isMissingVm(error)) throw error;
      }
    }

    try {
      const data = await dataBySlug(slug, workspace, signal);
      const replaced = workspace.providerId !== null && workspace.providerId !== data.id;
      return {
        workspace: { ...workspace, providerId: data.id },
        disposition: replaced ? "replaced" : "present",
        recovered: true,
        ...(workspace.providerId && workspace.providerId !== data.id
          ? { previousProviderId: workspace.providerId }
          : {}),
      };
    } catch (error) {
      if (isMissingVm(error))
        return {
          workspace: { ...workspace, providerId: null },
          disposition: "missing",
          recovered: false,
        };
      throw error;
    }
  }

  async function startIfNeeded(id: string, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let started = false;
    while (Date.now() < deadline) {
      const data = await dataById(id, signal);
      if (data.state === "running") return;
      if (data.state === "paused" || data.state === "stopped") {
        await boundedProviderCall({
          operation: "VM start",
          signal,
          timeoutMs,
          call: () => client.vms.ref(id).start(),
        });
        started = true;
      } else if (data.state !== "starting" && data.state !== "pausing") {
        throw safePublicError("VM start");
      }
      if (!started || data.state === "starting" || data.state === "pausing") await delay(100);
    }
    throw new SandboxProviderError(
      "timeout",
      "VM start",
      "Freestyle VM did not reach running state",
    );
  }

  async function waitForPausedOrStopped(id: string, signal: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const data = await dataById(id, signal);
      if (data.state === "paused" || data.state === "stopped") return true;
      if (data.state !== "pausing" && data.state !== "starting" && data.state !== "running")
        return false;
      await delay(100);
    }
    return false;
  }

  async function exec(
    workspace: WorkspaceRef,
    request: CommandRequest,
    signal: AbortSignal,
  ): Promise<CommandResult> {
    assertWorkspaceProvider(workspace, "freestyle");
    signal.throwIfAborted();
    const providerId = workspace.providerId;
    if (!providerId) throw new Error("Freestyle workspace has no provider id");
    const requestedTimeout = Math.max(1, request.timeoutMs ?? timeoutMs);
    try {
      const result = await boundedProviderCall({
        operation: "guest command",
        signal,
        timeoutMs: Math.max(timeoutMs, requestedTimeout + commandGraceMs),
        call: () =>
          client.vms.ref(providerId).exec({
            command: request.command,
            stdin:
              request.stdin === undefined
                ? undefined
                : Buffer.from(request.stdin, "utf8").toString("base64"),
            timeoutMs: requestedTimeout,
          }),
      });
      const stdout = boundedOutput(result.stdout ?? "", outputLimit);
      const remaining = Math.max(0, outputLimit - Buffer.byteLength(stdout.value, "utf8"));
      const stderr = boundedOutput(result.stderr ?? "", remaining);
      const truncated = stdout.truncated || stderr.truncated;
      if (truncated)
        return transportResult(
          "output-limit",
          "Freestyle command output exceeded the configured limit",
          stdout.value,
          stderr.value,
          true,
        );
      if (result.statusCode === null || result.statusCode === undefined)
        return transportResult(
          "transport-timeout",
          "Freestyle guest command timed out",
          stdout.value,
          stderr.value,
        );
      return processResult(stdout.value, stderr.value, result.statusCode, false);
    } catch (error) {
      if (isInterruption(error))
        return transportResult(
          error.kind === "timeout"
            ? "transport-timeout"
            : error.kind === "cancelled"
              ? "cancelled"
              : "unknown",
          error.kind === "timeout"
            ? "Freestyle guest command timed out"
            : error.kind === "cancelled"
              ? "Freestyle guest command cancelled"
              : "Freestyle guest command transport failed",
        );
      // Do not expose SDK request paths, headers, or response bodies to run
      // errors. Reconciliation gets the chance to identify a guest result.
      logger.warn({ workspaceId: workspace.id }, "Freestyle guest command transport failed");
      return transportResult("unknown", "Freestyle guest command transport failed");
    }
  }

  async function createVm(workspace: WorkspaceRef, slug: string, signal: AbortSignal) {
    return await boundedProviderCall({
      operation: "VM create",
      signal,
      timeoutMs,
      call: () =>
        client.vms.create({
          snapshotId: config.freestyleSnapshotId,
          slug,
          displayName: safeDisplayName(workspace.name),
          idleTimeoutSeconds: config.freestyleIdleTimeoutSeconds,
          autoDeleteSeconds: config.freestyleAutoDeleteSeconds,
          metadata: {
            [managedLabel]: "true",
            [managedWorkspaceLabel]: slug,
            [managedWorkspaceIdLabel]: workspace.id,
            [managedThreadIdLabel]: workspace.threadId,
          },
          firewall: {
            rules: [{ action: "allow", source: {}, destination: { public: true } }],
          },
        }),
    });
  }

  async function lifecycle(
    workspace: WorkspaceRef,
    action: "pause" | "delete",
    signal: AbortSignal,
  ): Promise<LifecycleResult> {
    assertWorkspaceProvider(workspace, "freestyle");
    try {
      const resolution = await resolveInternal(workspace, signal);
      if (resolution.disposition === "missing")
        return {
          action,
          outcome: "missing",
          providerId: null,
          recovered: false,
        };
      const id = resolution.workspace.providerId;
      if (!id) return lifecycleUnknown(action, workspace, resolution.recovered);
      if (action === "pause") {
        const deadline = Date.now() + timeoutMs;
        let pauseRequested = false;
        while (Date.now() < deadline) {
          const data = await dataById(id, signal);
          if (data.state === "paused" || data.state === "stopped") break;
          if (data.state === "running") {
            await boundedProviderCall({
              operation: "VM pause",
              signal,
              timeoutMs,
              call: () => client.vms.ref(id).pause(),
            });
            pauseRequested = true;
            break;
          }
          if (data.state !== "starting" && data.state !== "pausing")
            return lifecycleUnknown(action, workspace, resolution.recovered);
          await delay(100);
        }
        if (pauseRequested && !(await waitForPausedOrStopped(id, signal)))
          return lifecycleUnknown(action, workspace, resolution.recovered);
        if (!pauseRequested && Date.now() >= deadline)
          return lifecycleUnknown(action, workspace, resolution.recovered);
      } else {
        await boundedProviderCall({
          operation: "VM delete",
          signal,
          timeoutMs,
          call: () => client.vms.ref(id).delete(),
        });
        try {
          await dataById(id, signal);
          return lifecycleUnknown(action, workspace, resolution.recovered);
        } catch (error) {
          if (!isMissingVm(error)) throw error;
        }
      }
      logger.info(
        { workspaceId: workspace.id, providerId: id, action },
        "Freestyle lifecycle completed",
      );
      return {
        action,
        outcome: "completed",
        providerId: id,
        recovered: resolution.recovered,
      };
    } catch (error) {
      if (isMissingVm(error))
        return { action, outcome: "missing", providerId: null, recovered: false };
      if (isInterruption(error) || error instanceof FreestyleApiError) {
        logger.warn({ workspaceId: workspace.id, action }, "Freestyle lifecycle outcome unknown");
        return lifecycleUnknown(action, workspace, false);
      }
      throw safePublicError(`lifecycle ${action}`);
    }
  }

  return {
    async resolve(workspace, signal) {
      try {
        return await resolveInternal(workspace, signal);
      } catch (error) {
        if (isMissingVm(error))
          return {
            workspace: { ...workspace, providerId: null },
            disposition: "missing",
            recovered: false,
          };
        if (isInterruption(error)) throw error;
        throw safePublicError("VM resolve");
      }
    },
    async ensure(workspace, signal) {
      assertWorkspaceProvider(workspace, "freestyle");
      const originalProviderId = workspace.providerId;
      let resolution: WorkspaceResolution;
      try {
        resolution = await resolveInternal(workspace, signal);
      } catch (error) {
        if (isInterruption(error)) throw error;
        throw safePublicError("VM resolve");
      }
      if (resolution.disposition !== "missing" && resolution.workspace.providerId) {
        await startIfNeeded(resolution.workspace.providerId, signal);
        return {
          providerId: resolution.workspace.providerId,
          disposition: resolution.disposition === "replaced" ? "replaced" : "existing",
          ...(resolution.previousProviderId
            ? { previousProviderId: resolution.previousProviderId }
            : {}),
          recovered: resolution.recovered,
        };
      }

      const slug = safeSlug(workspace.name);
      let created: Awaited<ReturnType<typeof createVm>>;
      try {
        created = await createVm(workspace, slug, signal);
      } catch (error) {
        // Freestyle requests are backgrounded by the SDK. A client timeout or
        // cancellation may still have created the VM, so reconcile by slug
        // before allowing a retry to create a second resource.
        const reconcileSignal = AbortSignal.timeout(timeoutMs);
        try {
          const recovered = await dataBySlug(slug, workspace, reconcileSignal);
          await startIfNeeded(recovered.id, reconcileSignal);
          logger.warn(
            { workspaceId: workspace.id, providerId: recovered.id },
            "Reconciled Freestyle create",
          );
          return {
            providerId: recovered.id,
            disposition: originalProviderId ? "replaced" : "created",
            ...(originalProviderId ? { previousProviderId: originalProviderId } : {}),
            recovered: true,
          };
        } catch (reconcileError) {
          if (!isMissingVm(reconcileError)) throw safePublicError("VM create reconciliation");
          if (isInterruption(error)) throw error;
          throw safePublicError("VM create");
        }
      }
      await startIfNeeded(created.vmId, signal);
      logger.info(
        { workspaceId: workspace.id, providerId: created.vmId },
        "Freestyle sandbox created",
      );
      return {
        providerId: created.vmId,
        disposition: originalProviderId ? "replaced" : "created",
        ...(originalProviderId ? { previousProviderId: originalProviderId } : {}),
        recovered: false,
      };
    },
    async exec(workspace, request, signal) {
      return exec(workspace, request, signal);
    },
    async pause(workspace, signal) {
      return lifecycle(workspace, "pause", signal);
    },
    async delete(workspace, signal) {
      return lifecycle(workspace, "delete", signal);
    },
  };
}
