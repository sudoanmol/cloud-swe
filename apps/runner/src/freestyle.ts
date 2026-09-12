import { boundedUtf8 } from "./text.js";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { Freestyle, FreestyleApiError } from "freestyle";
import { ThreadStoreError } from "@cloud-swe/db/thread-contracts";
import type { DemoCompute, ComputeReservation } from "@cloud-swe/db/demo-compute";
import type { Logger } from "pino";
import type { RunnerConfig } from "./config.js";
import {
  assertWorkspaceProvider,
  boundedProviderCall,
  processResult,
  publicErrorFields,
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

class FreestyleUnavailableError extends SandboxProviderError {
  readonly code = "PROVIDER_UNAVAILABLE";
}

const inventorySchema = z.object({
  totalCount: z.number().int().nonnegative(),
  runningCount: z.number().int().nonnegative(),
  startingCount: z.number().int().nonnegative(),
  pausingCount: z.number().int().nonnegative(),
});

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

function safePublicError(operation: string, cause: unknown): Error {
  if (cause instanceof ThreadStoreError) return cause;
  const code = cause instanceof FreestyleApiError ? cause.code : undefined;

  if (
    ["VM_LIMIT_EXCEEDED", "CONCURRENT_VM_LIMIT_EXCEEDED", "SAVED_VM_LIMIT_EXCEEDED"].includes(
      code ?? "",
    )
  )
    return new ThreadStoreError("PROVIDER_CAPACITY", "Provider capacity is full", 503);

  if (["MONTHLY_COMPUTE_LIMIT_EXCEEDED", "MONTHLY_ALLOWANCE_EXHAUSTED"].includes(code ?? ""))
    return new ThreadStoreError(
      "PROVIDER_MONTHLY_ALLOWANCE",
      "Provider compute allowance is exhausted",
      503,
    );

  if (cause instanceof FreestyleApiError && cause.status >= 500)
    return new ThreadStoreError(
      "PROVIDER_UNAVAILABLE",
      "The provider is temporarily unavailable",
      503,
    );

  return new Error(`Freestyle ${operation} failed`, { cause });
}

function logProviderError(
  logger: Logger,
  workspace: WorkspaceRef,
  operation: string,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SDK rejections are logged only through a safe field projection.
  error: unknown,
) {
  logger.warn(
    {
      workspaceId: workspace.id,
      operation,
      ...publicErrorFields(error),
      status: error instanceof FreestyleApiError ? error.status : undefined,
    },
    `Freestyle ${operation} failed`,
  );
}

function isInterruption(error: unknown): error is SandboxProviderError {
  return error instanceof SandboxProviderError;
}

function boundedOutput(value: string, maxBytes: number) {
  const bounded = boundedUtf8(value, maxBytes);

  return { value: bounded.text, truncated: bounded.truncated };
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

export function createFreestyleProvider(
  config: RunnerConfig,
  logger: Logger,
  dependencies: {
    client?: Freestyle;
    compute?: DemoCompute;
    isOwner?: (threadId: string) => Promise<boolean>;
  } = {},
): SandboxProvider {
  const apiKey = config.freestyleApiKey;

  if (!apiKey) throw new Error("FREESTYLE_API_KEY is required for the Freestyle provider");

  if (!Number.isFinite(config.freestyleAutoDeleteSeconds) || config.freestyleAutoDeleteSeconds <= 0)
    throw new Error("Freestyle workspaces require a finite positive auto-delete timeout");

  if (!Number.isFinite(config.freestyleMaxRunSeconds) || config.freestyleMaxRunSeconds <= 0)
    throw new Error("Freestyle workspaces require a finite positive max-run timeout");
  const client = dependencies.client ?? new Freestyle({ apiKey });
  const timeoutMs = providerTimeoutMs(config);
  const outputLimit = providerOutputMaxBytes(config);
  const demoMaxRunSeconds = Math.floor(config.freestyleMaxRunSeconds);
  const compute = dependencies.compute;

  async function runtimePolicy(workspace: WorkspaceRef) {
    const owner = dependencies.compute
      ? (await dependencies.compute.currentRun(workspace.threadId)).access_policy === "owner"
      : ((await dependencies.isOwner?.(workspace.threadId)) ?? false);

    return {
      owner,
      maxRunSeconds: owner ? (config.freestyleOwnerMaxRunSeconds ?? 4500) : demoMaxRunSeconds,
      autoDeleteSeconds: owner ? -1 : config.freestyleAutoDeleteSeconds,
    };
  }

  async function capacity(creating: boolean, signal: AbortSignal) {
    const inventory = inventorySchema.parse(
      await boundedProviderCall({
        operation: "VM inventory",
        signal,
        timeoutMs,
        call: () => client.vms.list({ limit: 1 }),
      }),
    );

    const limit = config.freestyleVmLimit ?? 5;

    if (
      (creating && inventory.totalCount >= limit) ||
      inventory.runningCount + inventory.startingCount + inventory.pausingCount >= limit
    )
      throw new ThreadStoreError("PROVIDER_CAPACITY", "Provider capacity is full");
  }

  async function withBudget<T>(
    signal: AbortSignal,
    action: (boundedSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const deadline = new AbortController();

    const timer = setTimeout(
      () =>
        deadline.abort(
          new FreestyleUnavailableError(
            "timeout",
            "lifecycle",
            "The workspace provider is temporarily unavailable.",
          ),
        ),
      timeoutMs,
    );

    const boundedSignal = AbortSignal.any([signal, deadline.signal]);

    try {
      return await action(boundedSignal);
    } catch (error) {
      if (deadline.signal.aborted && !signal.aborted) throw deadline.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

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
        previousProviderId:
          workspace.providerId && workspace.providerId !== data.id
            ? workspace.providerId
            : undefined,
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

  async function applyMaxRunSeconds(
    id: string,
    workspace: WorkspaceRef,
    signal: AbortSignal,
    reservation?: ComputeReservation,
  ): Promise<void> {
    const data = await dataById(id, signal);

    const { maxRunSeconds, autoDeleteSeconds } = await runtimePolicy(workspace);

    const maxRunTotalSeconds = reservation
      ? Math.floor(reservation.baseline_seconds + reservation.reserved_seconds)
      : -1;

    if (
      data.maxRunSeconds === maxRunSeconds &&
      data.maxRunTotalSeconds === maxRunTotalSeconds &&
      (autoDeleteSeconds === -1
        ? data.autoDeleteFromPlan === true
        : data.autoDeleteSeconds === autoDeleteSeconds) &&
      data.automaticRestart === false
    )
      return;
    await boundedProviderCall({
      operation: "VM update",
      signal,
      timeoutMs,
      call: () =>
        client.vms.ref(id).update({
          maxRunSeconds,
          autoDeleteSeconds,
          maxRunTotalSeconds,
          automaticRestart: false,
        }),
    });
  }

  async function startIfNeeded(id: string, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let started = false;

    while (Date.now() < deadline) {
      const data = await dataById(id, signal);

      if (data.state === "running") return;

      if ((data.state === "paused" || data.state === "stopped") && !started) {
        await boundedProviderCall({
          operation: "VM start",
          signal,
          timeoutMs,
          call: () => client.vms.ref(id).start(),
        });
        started = true;
      } else if (!["starting", "pausing", "paused", "stopped"].includes(data.state)) {
        throw safePublicError("VM start", new Error(`Unexpected VM state: ${data.state}`));
      }

      await delay(100, undefined, { signal });
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
      await delay(100, undefined, { signal });
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

  async function createVm(
    workspace: WorkspaceRef,
    slug: string,
    signal: AbortSignal,
    reservation?: ComputeReservation,
  ) {
    const { maxRunSeconds, autoDeleteSeconds } = await runtimePolicy(workspace);

    try {
      await capacity(true, signal);
    } catch (error) {
      if (error instanceof ThreadStoreError && error.code === "PROVIDER_CAPACITY")
        await compute?.settle(workspace.id, 0, null);
      throw error;
    }

    const metadata = new Map<string, string>(
      Object.entries({
        [managedLabel]: "true",
        [managedWorkspaceLabel]: slug,
        [managedWorkspaceIdLabel]: workspace.id,
        [managedThreadIdLabel]: workspace.threadId,
      }),
    );

    if (reservation) metadata.set("cloud-swe.compute", reservation.id);

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
          // Unused-stopped deletion only. A running VM is never deleted for this.
          autoDeleteSeconds,
          // Pause one continuous run. Start resets this budget; it is not TTL.
          maxRunSeconds,
          maxRunTotalSeconds: reservation
            ? Math.floor(reservation.baseline_seconds + reservation.reserved_seconds)
            : undefined,
          automaticRestart: false,
          metadata: Object.fromEntries(metadata),
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

      if (resolution.disposition === "missing") {
        await compute?.settle(workspace.id, null);

        return {
          action,
          outcome: "missing",
          providerId: null,
          recovered: false,
        };
      }

      const id = resolution.workspace.providerId;

      if (!id) return lifecycleUnknown(action, workspace, resolution.recovered);

      if (compute) {
        const pending = await compute.outstanding(workspace.id, null);

        if (pending) {
          const data = await dataById(id, signal);

          if (data.metadata["cloud-swe.compute"] === pending.id)
            await compute.attach(pending.id, id);
        }
      }

      let finalRuntime: number | null = null;

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
          await delay(100, undefined, { signal });
        }

        if (pauseRequested && !(await waitForPausedOrStopped(id, signal)))
          return lifecycleUnknown(action, workspace, resolution.recovered);

        if (!pauseRequested && Date.now() >= deadline)
          return lifecycleUnknown(action, workspace, resolution.recovered);
      } else {
        const beforeDelete = await dataById(id, signal);

        if (beforeDelete.state === "paused" || beforeDelete.state === "stopped")
          finalRuntime = beforeDelete.totalRunSeconds ?? null;
        await boundedProviderCall({
          operation: "VM delete",
          signal,
          timeoutMs,
          call: () => client.vms.ref(id).delete(),
        });

        for (;;) {
          try {
            await dataById(id, signal);
          } catch (error) {
            if (isMissingVm(error)) break;
            throw error;
          }

          await delay(100, undefined, { signal });
        }
      }

      if (action === "pause") finalRuntime = (await dataById(id, signal)).totalRunSeconds ?? null;
      await compute?.settle(workspace.id, finalRuntime, id);
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

      logProviderError(logger, workspace, `lifecycle ${action}`, error);
      throw safePublicError(`lifecycle ${action}`, error);
    }
  }

  async function resolve(
    workspace: WorkspaceRef,
    signal: AbortSignal,
  ): Promise<WorkspaceResolution> {
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
      logProviderError(logger, workspace, "VM resolve", error);
      throw safePublicError("VM resolve", error);
    }
  }

  async function ensure(
    workspace: WorkspaceRef,
    signal: AbortSignal,
  ): ReturnType<SandboxProvider["ensure"]> {
    assertWorkspaceProvider(workspace, "freestyle");
    const originalProviderId = workspace.providerId;
    let resolution: WorkspaceResolution;

    try {
      resolution = await resolveInternal(workspace, signal);
    } catch (error) {
      if (isInterruption(error)) throw error;
      logProviderError(logger, workspace, "VM resolve during ensure", error);
      throw safePublicError("VM resolve", error);
    }

    let reservation: ComputeReservation | undefined;

    if (compute) {
      for (const observation of await compute.observations()) {
        if (!observation.provider_id) continue;

        try {
          const data = await dataById(observation.provider_id, signal);

          if (
            data.metadata[managedWorkspaceIdLabel] === observation.workspace_id &&
            data.totalRunSeconds !== undefined
          )
            await compute.observe(observation.workspace_id, data.totalRunSeconds, data.id);
        } catch (error) {
          if (!isMissingVm(error)) throw error;
        }
      }

      const active = await compute.currentRun(workspace.threadId);
      const prior = await compute.outstanding(workspace.id, resolution.workspace.providerId);

      let data = resolution.workspace.providerId
        ? await dataById(resolution.workspace.providerId, signal)
        : null;

      if (
        prior &&
        (prior.run_id !== active.id || (prior.provider_id && prior.provider_id !== data?.id))
      ) {
        if (
          data &&
          prior.provider_id === data.id &&
          data.state !== "paused" &&
          data.state !== "stopped"
        ) {
          const paused = await lifecycle(workspace, "pause", signal);

          if (paused.outcome === "unknown")
            throw new ThreadStoreError("PROVIDER_UNAVAILABLE", "Provider state is unknown");
          data = await dataById(data.id, signal);
        }

        await compute.settle(
          workspace.id,
          data && prior.provider_id === data.id ? (data.totalRunSeconds ?? null) : null,
          prior.provider_id,
        );
      }

      if (active.access_policy === "demo") {
        if (!prior && data && data.state !== "paused" && data.state !== "stopped") {
          const paused = await lifecycle(workspace, "pause", signal);

          if (paused.outcome === "unknown")
            throw new ThreadStoreError(
              "PROVIDER_UNAVAILABLE",
              "Cannot establish a demo runtime baseline",
            );
          data = await dataById(data.id, signal);
        }

        if (
          data &&
          (!Number.isFinite(data.totalRunSeconds) ||
            data.resources.cpu !== 2 ||
            data.resources.memory !== 4096)
        )
          throw new ThreadStoreError(
            "INVALID_CONFIGURATION",
            "Demo workspace resources or runtime could not be verified",
          );
        reservation = await compute.reserve({
          workspaceId: workspace.id,
          runId: active.id,
          seconds: demoMaxRunSeconds,
          baselineSeconds: data?.totalRunSeconds ?? 0,
          providerId: data?.id ?? null,
        });

        if (
          data &&
          data.metadata["cloud-swe.compute"] === reservation.id &&
          data.state !== "running" &&
          data.state !== "starting"
        )
          throw new ThreadStoreError(
            "DEMO_RUNTIME_EXPIRED",
            "An interrupted demo VM cannot restart on the same reservation",
          );
      }
    }

    if (resolution.disposition !== "missing" && resolution.workspace.providerId) {
      await applyMaxRunSeconds(resolution.workspace.providerId, workspace, signal, reservation);
      const currentData = await dataById(resolution.workspace.providerId, signal);

      if (currentData.state !== "running") await capacity(false, signal);

      if (reservation) {
        const id = resolution.workspace.providerId;
        const reservationId = reservation.id;
        await boundedProviderCall({
          operation: "VM reservation metadata",
          signal,
          timeoutMs,
          call: () =>
            client.vms.ref(id).update({ metadata: { "cloud-swe.compute": reservationId } }),
        });
        await compute?.attach(reservation.id, resolution.workspace.providerId);
      }

      await startIfNeeded(resolution.workspace.providerId, signal);

      return {
        providerId: resolution.workspace.providerId,
        disposition: resolution.disposition === "replaced" ? "replaced" : "existing",
        previousProviderId: resolution.previousProviderId || undefined,
        recovered: resolution.recovered,
      };
    }

    const slug = safeSlug(workspace.name);
    let created: Awaited<ReturnType<typeof createVm>>;

    try {
      created = await createVm(workspace, slug, signal, reservation);
    } catch (error) {
      if (error instanceof ThreadStoreError) throw error;

      // Freestyle requests are backgrounded by the SDK. A client timeout or
      // cancellation may still have created the VM, so reconcile by slug
      // before allowing a retry to create a second resource.
      if (signal.aborted) throw error;
      const confirmed = safePublicError("VM create", error);

      if (
        confirmed instanceof ThreadStoreError &&
        ["PROVIDER_CAPACITY", "PROVIDER_MONTHLY_ALLOWANCE"].includes(confirmed.code)
      ) {
        await compute?.settle(workspace.id, 0, null);
        throw confirmed;
      }

      const reconcileSignal = signal;

      try {
        const recovered = await dataBySlug(slug, workspace, reconcileSignal);

        if (reservation) {
          await compute?.attach(reservation.id, recovered.id);

          if (recovered.state !== "running" && recovered.state !== "starting")
            throw new ThreadStoreError(
              "DEMO_RUNTIME_EXPIRED",
              "Demo VM cannot restart after an ambiguous create",
            );
        }

        await applyMaxRunSeconds(recovered.id, workspace, reconcileSignal, reservation);
        await startIfNeeded(recovered.id, reconcileSignal);
        logger.warn(
          { workspaceId: workspace.id, providerId: recovered.id },
          "Reconciled Freestyle create",
        );

        return {
          providerId: recovered.id,
          disposition: originalProviderId ? "replaced" : "created",
          previousProviderId: originalProviderId || undefined,
          recovered: true,
        };
      } catch (reconcileError) {
        if (!isMissingVm(reconcileError)) {
          logProviderError(logger, workspace, "VM create reconciliation", reconcileError);
          throw safePublicError("VM create reconciliation", reconcileError);
        }

        if (isInterruption(error)) throw error;
        logProviderError(logger, workspace, "VM create", error);
        throw safePublicError("VM create", error);
      }
    }

    if (reservation) {
      await compute?.attach(reservation.id, created.vmId);
      const data = await dataById(created.vmId, signal);

      if (data.state !== "running" && data.state !== "starting")
        throw new ThreadStoreError("DEMO_RUNTIME_EXPIRED", "Demo VM stopped before preparation");

      if (data.resources.cpu !== 2 || data.resources.memory !== 4096)
        throw new ThreadStoreError(
          "INVALID_CONFIGURATION",
          "Demo VM resources do not match the verified small shape",
        );
    }

    await startIfNeeded(created.vmId, signal);
    logger.info(
      { workspaceId: workspace.id, providerId: created.vmId },
      "Freestyle sandbox created",
    );

    return {
      providerId: created.vmId,
      disposition: originalProviderId ? "replaced" : "created",
      previousProviderId: originalProviderId || undefined,
      recovered: false,
    };
  }

  return {
    resolve: (workspace, signal) =>
      withBudget(signal, (boundedSignal) => resolve(workspace, boundedSignal)),
    ensure: (workspace, signal) =>
      withBudget(signal, (boundedSignal) => ensure(workspace, boundedSignal)).catch((error) => {
        if (isInterruption(error)) throw error;
        throw safePublicError("VM preparation", error);
      }),
    exec,
    pause: (workspace, signal) =>
      withBudget(signal, (boundedSignal) => lifecycle(workspace, "pause", boundedSignal)),
    delete: (workspace, signal) =>
      withBudget(signal, (boundedSignal) => lifecycle(workspace, "delete", boundedSignal)),
  };
}
