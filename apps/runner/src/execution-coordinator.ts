import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { CommandOperationRecord, ThreadStore } from "@cloud-swe/db/thread-contracts";
import type { Logger } from "pino";
import type { RunnerConfig } from "./config.js";
import {
  buildGuestCommandRequest,
  buildGuestReconcileRequest,
  guestCommandStateIsSettled,
  newCommandOwner,
  parseGuestCommandObservation,
  type GuestCommandObservation,
  type GuestCommandOwner,
} from "./guest-command.js";
import {
  commandOutputMaxBytes,
  isProcessResult,
  reconcileTimeoutMs,
  type CommandRequest,
  type CommandResult,
  type SandboxProvider,
  type SandboxProviders,
  type WorkspaceRef,
} from "./sandbox.js";

export type CommandOperationStore = Pick<
  ThreadStore,
  "beginCommand" | "readCommand" | "listUnsettledCommands" | "updateCommand"
>;

export type ExecutionCoordinatorConfig = Pick<
  RunnerConfig,
  "providerTimeoutMs" | "commandReconcileTimeoutMs" | "commandOutputMaxBytes"
>;

export type CoordinatedCommandResult = {
  commandId: string;
  state: "completed" | "failed";
  stdout: string;
  stderr: string;
  statusCode: number;
  outputTruncated: boolean;
  timedOut: boolean;
  cancellationRequested: boolean;
  /** The client lost transport after dispatch, but reconciliation settled the guest command. */
  reconciledAfterTransport: boolean;
};

export class UnresolvedCommandError extends Error {
  readonly workspaceId: string;
  readonly generation: number;
  readonly commandId: string;

  constructor(input: {
    workspaceId: string;
    generation: number;
    commandId: string;
    message?: string;
  }) {
    super(
      input.message ??
        `Workspace ${input.workspaceId} generation ${input.generation} has unresolved command ${input.commandId}`,
    );
    this.name = "UnresolvedCommandError";
    this.workspaceId = input.workspaceId;
    this.generation = input.generation;
    this.commandId = input.commandId;
  }
}

export class CommandCancelledBeforeDispatchError extends Error {
  readonly commandId: string;

  constructor(commandId: string) {
    super(`Command ${commandId} was cancelled before provider dispatch`);
    this.name = "CommandCancelledBeforeDispatchError";
    this.commandId = commandId;
  }
}

export class CommandUnknownError extends UnresolvedCommandError {
  readonly reason: string;

  constructor(input: {
    workspaceId: string;
    generation: number;
    commandId: string;
    reason: string;
  }) {
    super({ ...input, message: `Command ${input.commandId} outcome is unknown: ${input.reason}` });
    this.name = "CommandUnknownError";
    this.reason = input.reason;
  }
}

export type ExecutionCoordinator = {
  execute(input: {
    workspace: WorkspaceRef;
    request: CommandRequest;
    runId: string;
    attemptId: string;
    commandId?: string;
    signal: AbortSignal;
  }): Promise<CoordinatedCommandResult>;
  reconcile(input: {
    workspace: WorkspaceRef;
    commandId: string;
    signal: AbortSignal;
  }): Promise<CoordinatedCommandResult>;
  reconcileUnsettled(input: { workspace: WorkspaceRef; signal: AbortSignal }): Promise<void>;
};

type StoredProcessResult = {
  kind: "completed" | "failed";
  stdout: string;
  stderr: string;
  statusCode: number;
  outputTruncated: boolean;
  timedOut: boolean;
  reconciledAfterTransport?: boolean;
};

type CommandMetadata = {
  kind: "guest-command";
  commandId: string;
  workspace: WorkspaceRef;
  runId: string;
  attemptId: string;
  request: { command: string; timeoutMs: number };
  outputMaxBytes: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function storedProcessResult(value: unknown): StoredProcessResult | null {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  const stdout = value.stdout;
  const stderr = value.stderr;
  const statusCode = value.statusCode;
  const outputTruncated = value.outputTruncated;
  const timedOut = value.timedOut;
  if (
    (kind !== "completed" && kind !== "failed") ||
    typeof stdout !== "string" ||
    typeof stderr !== "string" ||
    typeof statusCode !== "number" ||
    !Number.isInteger(statusCode) ||
    typeof outputTruncated !== "boolean" ||
    typeof timedOut !== "boolean"
  )
    return null;
  return {
    kind,
    stdout,
    stderr,
    statusCode,
    outputTruncated,
    timedOut,
    ...(value.reconciledAfterTransport === true ? { reconciledAfterTransport: true } : {}),
  };
}

function commandMetadata(value: unknown): CommandMetadata | null {
  if (!isRecord(value) || value.kind !== "guest-command") return null;
  const workspace = value.workspace;
  const request = value.request;
  if (
    !isRecord(workspace) ||
    typeof workspace.id !== "string" ||
    typeof workspace.threadId !== "string" ||
    typeof workspace.name !== "string" ||
    (workspace.provider !== "docker" && workspace.provider !== "freestyle") ||
    (typeof workspace.providerId !== "string" && workspace.providerId !== null) ||
    typeof workspace.generation !== "number" ||
    typeof value.commandId !== "string" ||
    typeof value.runId !== "string" ||
    typeof value.attemptId !== "string" ||
    !isRecord(request) ||
    typeof request.command !== "string" ||
    typeof request.timeoutMs !== "number" ||
    typeof value.outputMaxBytes !== "number"
  )
    return null;
  return {
    kind: "guest-command",
    commandId: value.commandId,
    workspace: {
      id: workspace.id,
      threadId: workspace.threadId,
      name: workspace.name,
      provider: workspace.provider,
      providerId: workspace.providerId,
      generation: workspace.generation,
    },
    runId: value.runId,
    attemptId: value.attemptId,
    request: { command: request.command, timeoutMs: request.timeoutMs },
    outputMaxBytes: value.outputMaxBytes,
  };
}

function commandMetadataMatches(
  metadata: CommandMetadata | null,
  input: {
    commandId: string;
    workspace: WorkspaceRef;
    runId: string;
    attemptId: string;
  },
): boolean {
  if (!metadata) return false;
  const { workspace } = metadata;
  return (
    metadata.commandId === input.commandId &&
    metadata.runId === input.runId &&
    metadata.attemptId === input.attemptId &&
    workspace.id === input.workspace.id &&
    workspace.threadId === input.workspace.threadId &&
    workspace.name === input.workspace.name &&
    workspace.provider === input.workspace.provider &&
    workspace.providerId === input.workspace.providerId &&
    workspace.generation === input.workspace.generation
  );
}

function ownerFromRecord(
  record: CommandOperationRecord,
  workspace: WorkspaceRef,
): GuestCommandOwner {
  return {
    commandId: record.commandId,
    workspace,
    runId: record.runId,
    attemptId: record.attemptId,
  };
}

function providerFor(providers: SandboxProviders, workspace: WorkspaceRef): SandboxProvider {
  const provider = providers[workspace.provider];
  if (!provider) throw new Error(`Sandbox provider ${workspace.provider} is not configured`);
  return provider;
}

function processObservation(
  observation: GuestCommandObservation,
  commandId: string,
  cancellationRequested: boolean,
  reconciledAfterTransport: boolean,
): CoordinatedCommandResult | null {
  if (!guestCommandStateIsSettled(observation.state) || observation.statusCode === null)
    return null;
  return {
    commandId,
    state: observation.state,
    stdout: observation.stdout,
    stderr: observation.stderr,
    statusCode: observation.statusCode,
    outputTruncated: observation.outputTruncated,
    timedOut: observation.timedOut,
    cancellationRequested,
    reconciledAfterTransport,
  };
}

function storedResult(
  record: CommandOperationRecord,
  commandId: string,
): CoordinatedCommandResult | null {
  const result = storedProcessResult(record.result);
  if (!result) return null;
  return {
    commandId,
    state: result.kind,
    stdout: result.stdout,
    stderr: result.stderr,
    statusCode: result.statusCode,
    outputTruncated: result.outputTruncated,
    timedOut: result.timedOut,
    cancellationRequested: record.cancellationRequested,
    reconciledAfterTransport: result.reconciledAfterTransport === true,
  };
}

function safeErrorMessage(_error: unknown, fallback: string): string {
  return fallback;
}

export function createExecutionCoordinator(input: {
  providers: SandboxProviders;
  store: CommandOperationStore;
  config: ExecutionCoordinatorConfig;
  logger?: Logger;
}): ExecutionCoordinator {
  const { providers, store, config, logger } = input;
  const outputMaxBytes = commandOutputMaxBytes(config);
  const reconciliationMs = reconcileTimeoutMs(config);

  async function settle(
    record: CommandOperationRecord,
    result: CoordinatedCommandResult,
  ): Promise<CoordinatedCommandResult> {
    const stored: StoredProcessResult = {
      kind: result.state,
      stdout: result.stdout,
      stderr: result.stderr,
      statusCode: result.statusCode,
      outputTruncated: result.outputTruncated,
      timedOut: result.timedOut,
      ...(result.reconciledAfterTransport ? { reconciledAfterTransport: true } : {}),
    };
    await store.updateCommand({
      commandId: record.commandId,
      state: result.state,
      cancellationRequested: result.cancellationRequested,
      result: stored,
    });
    return result;
  }

  async function reconcileRecord(inputValue: {
    record: CommandOperationRecord;
    workspace: WorkspaceRef;
    signal: AbortSignal;
    reconciledAfterTransport: boolean;
  }): Promise<CoordinatedCommandResult> {
    const { record, workspace, signal, reconciledAfterTransport } = inputValue;
    if (
      !commandMetadataMatches(commandMetadata(record.metadata), {
        commandId: record.commandId,
        workspace,
        runId: record.runId,
        attemptId: record.attemptId,
      })
    ) {
      const reason = "command ownership metadata does not match the current workspace generation";
      await store.updateCommand({
        commandId: record.commandId,
        state: "unknown",
        result: { kind: "unknown", reason },
      });
      throw new CommandUnknownError({
        workspaceId: workspace.id,
        generation: workspace.generation,
        commandId: record.commandId,
        reason,
      });
    }
    const provider = providerFor(providers, workspace);
    const owner = ownerFromRecord(record, workspace);
    const deadline = Date.now() + reconciliationMs;
    let lastReason = "guest command has no settled status";
    while (Date.now() < deadline) {
      if (signal.aborted) {
        lastReason = "reconciliation deadline or cancellation reached";
        break;
      }
      let response: CommandResult;
      try {
        response = await provider.exec(
          workspace,
          buildGuestReconcileRequest({ owner, timeoutMs: Math.min(5_000, reconciliationMs) }),
          signal,
        );
      } catch {
        // A reconciliation transport error is itself ambiguous. Keep polling
        // within the bounded reconciliation window; never rerun the command.
        lastReason = "provider reconciliation did not return a guest status";
        if (!signal.aborted) await delay(100);
        continue;
      }
      const observation = parseGuestCommandObservation(response, owner);
      const result = processObservation(
        observation,
        record.commandId,
        record.cancellationRequested,
        reconciledAfterTransport,
      );
      if (result) return await settle(record, result);
      if (observation.state === "unknown") {
        lastReason = observation.reason ?? "guest reconciliation protocol failed";
        break;
      }
      lastReason = `guest command is ${observation.state}`;
      await delay(100);
    }
    await store.updateCommand({
      commandId: record.commandId,
      state: "unknown",
      cancellationRequested: record.cancellationRequested,
      result: { kind: "unknown", reason: lastReason.slice(0, 500) },
    });
    throw new CommandUnknownError({
      workspaceId: workspace.id,
      generation: workspace.generation,
      commandId: record.commandId,
      reason: lastReason,
    });
  }

  async function reconcile(inputValue: {
    workspace: WorkspaceRef;
    commandId: string;
    signal: AbortSignal;
  }): Promise<CoordinatedCommandResult> {
    inputValue.signal.throwIfAborted();
    const record = await store.readCommand(inputValue.commandId);
    if (!record)
      throw new Error(`Command operation ${inputValue.commandId} was not found for reconciliation`);
    if (
      record.workspaceId !== inputValue.workspace.id ||
      record.generation !== inputValue.workspace.generation
    )
      throw new UnresolvedCommandError({
        workspaceId: inputValue.workspace.id,
        generation: inputValue.workspace.generation,
        commandId: inputValue.commandId,
        message: "Command operation belongs to another workspace generation",
      });
    const alreadySettled = storedResult(record, record.commandId);
    if (alreadySettled && (record.state === "completed" || record.state === "failed"))
      return alreadySettled;
    return reconcileRecord({
      record,
      workspace: inputValue.workspace,
      signal: inputValue.signal,
      reconciledAfterTransport: false,
    });
  }

  async function reconcileUnsettled(inputValue: {
    workspace: WorkspaceRef;
    signal: AbortSignal;
  }): Promise<void> {
    const records = await store.listUnsettledCommands({
      workspaceId: inputValue.workspace.id,
      generation: inputValue.workspace.generation,
    });
    for (const record of records) {
      await reconcile({
        workspace: inputValue.workspace,
        commandId: record.commandId,
        signal: inputValue.signal,
      });
    }
  }

  async function execute(inputValue: {
    workspace: WorkspaceRef;
    request: CommandRequest;
    runId: string;
    attemptId: string;
    commandId?: string;
    signal: AbortSignal;
  }): Promise<CoordinatedCommandResult> {
    const { workspace, request, runId, attemptId, signal } = inputValue;
    signal.throwIfAborted();
    const requestedCommandId = inputValue.commandId ?? randomUUID();
    const unsettled = await store.listUnsettledCommands({
      workspaceId: workspace.id,
      generation: workspace.generation,
    });
    const other = unsettled.find((record) => record.commandId !== requestedCommandId);
    if (other)
      throw new UnresolvedCommandError({
        workspaceId: workspace.id,
        generation: workspace.generation,
        commandId: other.commandId,
      });
    const existing = unsettled.find((record) => record.commandId === requestedCommandId);
    if (existing) {
      const existingResult = storedResult(existing, existing.commandId);
      if (existingResult) return existingResult;
      const reconciliationSignal = AbortSignal.timeout(reconciliationMs);
      return reconcileRecord({
        record: existing,
        workspace,
        signal: reconciliationSignal,
        reconciledAfterTransport: false,
      });
    }

    const timeoutMs = Math.max(1, request.timeoutMs ?? config.providerTimeoutMs);
    const owner = newCommandOwner({
      workspace,
      runId,
      attemptId,
      commandId: requestedCommandId,
    });
    const metadata: CommandMetadata = {
      kind: "guest-command",
      commandId: owner.commandId,
      workspace,
      runId,
      attemptId,
      request: { command: request.command, timeoutMs },
      outputMaxBytes,
    };
    signal.throwIfAborted();
    const record = await store.beginCommand({
      commandId: owner.commandId,
      workspaceId: workspace.id,
      generation: workspace.generation,
      runId,
      attemptId,
      metadata,
    });
    const persistedMetadata = commandMetadata(record.metadata);
    if (
      !commandMetadataMatches(persistedMetadata, {
        commandId: owner.commandId,
        workspace,
        runId,
        attemptId,
      })
    ) {
      throw new CommandUnknownError({
        workspaceId: workspace.id,
        generation: workspace.generation,
        commandId: owner.commandId,
        reason: "persisted command ownership metadata does not match the dispatch request",
      });
    }
    if (record.state === "completed" || record.state === "failed") {
      const result = storedResult(record, record.commandId);
      if (result) return result;
      throw new CommandUnknownError({
        workspaceId: workspace.id,
        generation: workspace.generation,
        commandId: owner.commandId,
        reason: "terminal command has no guest process result",
      });
    }

    const settleNotDispatched = async (): Promise<never> => {
      await store.updateCommand({
        commandId: owner.commandId,
        state: "failed",
        cancellationRequested: true,
        result: { kind: "cancelled-before-dispatch" },
      });
      throw new CommandCancelledBeforeDispatchError(owner.commandId);
    };
    if (signal.aborted) return settleNotDispatched();
    await store.updateCommand({ commandId: owner.commandId, state: "running" });
    if (signal.aborted) return settleNotDispatched();

    let cancellationRequested = false;
    let cancellationFailure: unknown;
    let cancellationUpdate: Promise<void> = Promise.resolve();
    const onAbort = () => {
      cancellationRequested = true;
      const next = cancellationUpdate.then(async () => {
        await store.updateCommand({ commandId: owner.commandId, cancellationRequested: true });
      });
      cancellationUpdate = next.catch((error: unknown) => {
        cancellationFailure ??= error;
        throw error;
      });
      // The abort event cannot await. Retain and observe the failure now; the
      // dispatch path awaits the same promise before it can release ownership.
      void cancellationUpdate.catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      const provider = providerFor(providers, workspace);
      const fencedRequest = buildGuestCommandRequest({
        owner,
        request: { ...request, timeoutMs },
        outputMaxBytes,
      });
      let response: CommandResult | undefined;
      let providerFailed = false;
      try {
        // Every invocation after this point is treated as dispatched from the
        // coordinator's perspective. Provider implementations pre-check the
        // signal before creating their SDK/process request.
        response = await provider.exec(workspace, fencedRequest, signal);
      } catch {
        providerFailed = true;
      }
      if (cancellationFailure !== undefined) throw cancellationFailure;
      await cancellationUpdate;
      const reconciliationSignal = AbortSignal.timeout(reconciliationMs);
      if (providerFailed || !response) {
        try {
          return await reconcileRecord({
            record: { ...record, cancellationRequested },
            workspace,
            signal: reconciliationSignal,
            reconciledAfterTransport: true,
          });
        } catch (reconciliationError) {
          logger?.warn(
            {
              commandId: owner.commandId,
              workspaceId: workspace.id,
              error: safeErrorMessage(reconciliationError, "command reconciliation failed"),
            },
            "Command remains unresolved after provider interruption",
          );
          throw reconciliationError;
        }
      }
      const observation = parseGuestCommandObservation(response, owner);
      const transportLost = !isProcessResult(response) || observation.state === "unknown";
      return await reconcileRecord({
        record: { ...record, cancellationRequested },
        workspace,
        signal: reconciliationSignal,
        reconciledAfterTransport: transportLost,
      });
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  return { execute, reconcile, reconcileUnsettled };
}
