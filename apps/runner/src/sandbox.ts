import type {
  CleanupProviderResult,
  WorkspaceRef,
  SandboxProviderName,
} from "@cloud-swe/db/thread-contracts";
import type { RunnerConfig } from "./config.js";

export type { WorkspaceRef } from "@cloud-swe/db/thread-contracts";

export type SandboxProviders = Partial<Record<SandboxProviderName, SandboxProvider>>;

/** The request sent to a provider after the execution coordinator has prepared it. */
export type CommandRequest = {
  command: string;
  stdin?: string;
  /** The guest command's own wall-clock limit. */
  timeoutMs?: number;
};

export type ProcessCommandResult = {
  kind: "completed" | "failed";
  stdout: string;
  stderr: string;
  /** A guest-known process exit. A non-zero code is a tool result, not transport failure. */
  statusCode: number;
  /** True when the provider had to bound the returned diagnostics. */
  outputTruncated: boolean;
};

export type TransportCommandResult = {
  kind: "transport-timeout" | "cancelled" | "unknown" | "output-limit";
  stdout: string;
  stderr: string;
  statusCode: null;
  outputTruncated: boolean;
  error?: string;
};

/**
 * A provider result deliberately separates a guest process result from a lost
 * transport. Callers must reconcile transport results before they release the
 * workspace command owner or retry the operation.
 */
export type CommandResult = ProcessCommandResult | TransportCommandResult;

export type EnsureDisposition = "existing" | "created" | "replaced";

export type EnsureResult = {
  providerId: string;
  disposition: EnsureDisposition;
  /** The previous id when a known provider resource was replaced. */
  previousProviderId?: string;
  /** True when the id was recovered from the stable workspace name. */
  recovered: boolean;
};

export type WorkspaceResolution = {
  workspace: WorkspaceRef;
  disposition: "present" | "replaced" | "missing";
  /** True when providerId was recovered from the provider's stable name/slug. */
  recovered: boolean;
  /** The id that was missing when a stable name resolved to a replacement resource. */
  previousProviderId?: string;
};

export type LifecycleAction = "pause" | "delete";

export type LifecycleResult = CleanupProviderResult & {
  action: LifecycleAction;
  /** True when providerId was recovered from the stable workspace name. */
  recovered: boolean;
};

export type SandboxProvider = {
  /** Resolve an id from the stable workspace identity without changing its lifecycle. */
  resolve(workspace: WorkspaceRef, signal: AbortSignal): Promise<WorkspaceResolution>;
  /** Ensure the resource exists and is usable, reporting whether its filesystem changed. */
  ensure(workspace: WorkspaceRef, signal: AbortSignal): Promise<EnsureResult>;
  /** Execute one ordinary provider command. Guest fencing is owned by the coordinator. */
  exec(
    workspace: WorkspaceRef,
    request: CommandRequest,
    signal: AbortSignal,
  ): Promise<CommandResult>;
  pause(workspace: WorkspaceRef, signal: AbortSignal): Promise<LifecycleResult>;
  delete(workspace: WorkspaceRef, signal: AbortSignal): Promise<LifecycleResult>;
};

export type ProviderTimeoutConfig = Pick<
  RunnerConfig,
  "providerTimeoutMs" | "commandReconcileTimeoutMs" | "commandOutputMaxBytes"
>;

/** Space reserved for the guest status/diagnostic framing around user output. */
export const commandProtocolOverheadBytes = 16_384;

export const defaultProviderTimeoutConfig: ProviderTimeoutConfig = {
  providerTimeoutMs: 30_000,
  commandReconcileTimeoutMs: 30_000,
  commandOutputMaxBytes: 262_144,
};

export class SandboxProviderError extends Error {
  readonly kind: "timeout" | "cancelled" | "unknown";
  readonly operation: string;

  constructor(
    kind: "timeout" | "cancelled" | "unknown",
    operation: string,
    message = `Sandbox ${operation} ${kind}`,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SandboxProviderError";
    this.kind = kind;
    this.operation = operation;
  }
}

/**
 * Fields safe to put on a server log line. Omits messages and causes that may
 * carry SDK URLs, headers, or response bodies.
 */
export function publicErrorFields(error: unknown): Record<string, unknown> {
  if (error instanceof SandboxProviderError)
    return { errName: error.name, errKind: error.kind, operation: error.operation };
  if (error instanceof Error) return { errName: error.name };
  return { errName: "unknown" };
}

export function isProcessResult(result: CommandResult): result is ProcessCommandResult {
  return result.kind === "completed" || result.kind === "failed";
}

export function processResult(
  stdout: string,
  stderr: string,
  statusCode: number,
  outputTruncated = false,
): ProcessCommandResult {
  return {
    kind: statusCode === 0 ? "completed" : "failed",
    stdout,
    stderr,
    statusCode,
    outputTruncated,
  };
}

export function transportResult(
  kind: TransportCommandResult["kind"],
  message?: string,
  stdout = "",
  stderr = "",
  outputTruncated = false,
): TransportCommandResult {
  return {
    kind,
    stdout,
    stderr,
    statusCode: null,
    outputTruncated,
    ...(message ? { error: message } : {}),
  };
}

function finitePositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function providerTimeoutMs(config: Partial<ProviderTimeoutConfig>): number {
  return finitePositive(config.providerTimeoutMs, defaultProviderTimeoutConfig.providerTimeoutMs);
}

export function reconcileTimeoutMs(config: Partial<ProviderTimeoutConfig>): number {
  return finitePositive(
    config.commandReconcileTimeoutMs,
    defaultProviderTimeoutConfig.commandReconcileTimeoutMs,
  );
}

export function commandOutputMaxBytes(config: Partial<ProviderTimeoutConfig>): number {
  return Math.max(
    1,
    Math.floor(
      finitePositive(
        config.commandOutputMaxBytes,
        defaultProviderTimeoutConfig.commandOutputMaxBytes,
      ),
    ),
  );
}

export function providerOutputMaxBytes(config: Partial<ProviderTimeoutConfig>): number {
  return commandOutputMaxBytes(config) + commandProtocolOverheadBytes;
}

/**
 * Bound SDK lifecycle/data calls. The underlying SDK request may continue after
 * the client deadline, so a timeout is never treated as confirmation that the
 * provider operation failed or that the resource is missing.
 */
export async function boundedProviderCall<T>(input: {
  operation: string;
  signal: AbortSignal;
  timeoutMs: number;
  call: () => Promise<T>;
}): Promise<T> {
  const { operation, signal, timeoutMs, call } = input;
  const cancelled = () =>
    new SandboxProviderError("cancelled", operation, `Sandbox ${operation} cancelled`, {
      cause: signal.reason,
    });
  if (signal.aborted) throw cancelled();
  const duration = finitePositive(timeoutMs, defaultProviderTimeoutConfig.providerTimeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let removeAbort: () => void = () => undefined;
  const request = Promise.resolve().then(() => {
    // The caller can abort after the first check but before this deferred
    // callback runs. Never dispatch a provider call across that gap.
    if (signal.aborted) throw cancelled();
    return call();
  });
  // A bounded race intentionally leaves the provider request alive. Attach a
  // rejection handler so a late SDK failure is not an unhandled rejection.
  request.catch(() => undefined);
  return await new Promise<T>((resolve, reject) => {
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      removeAbort();
      callback();
    };
    const onAbort = () => finish(() => reject(cancelled()));
    removeAbort = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(
      () =>
        finish(() =>
          reject(new SandboxProviderError("timeout", operation, `Sandbox ${operation} timed out`)),
        ),
      duration,
    );
    request.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export function assertWorkspaceProvider(
  workspace: WorkspaceRef,
  provider: SandboxProviderName,
): void {
  if (workspace.provider !== provider)
    throw new Error(
      `Workspace ${workspace.id} uses provider ${workspace.provider}, not ${provider}`,
    );
}
