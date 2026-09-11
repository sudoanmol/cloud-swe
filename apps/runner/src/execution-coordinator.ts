import { setTimeout as delay } from "node:timers/promises";
import type { CommandOperationRecord, ThreadStore } from "@cloud-swe/db/thread-contracts";
import type { Logger } from "pino";
import { z } from "zod";
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
  publicErrorFields,
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

/**
 * hold-fence: the command may still mutate this generation. Do not start
 * another mutating command and do not treat the workspace as idle.
 * quarantine-generation: rebuild/reset of this generation is safe.
 */
export type UnknownCommandRecovery = "hold-fence" | "quarantine-generation";

export class CommandUnknownError extends UnresolvedCommandError {
  readonly reason: string;
  readonly recovery: UnknownCommandRecovery;

  constructor(input: {
    workspaceId: string;
    generation: number;
    commandId: string;
    reason: string;
    recovery: UnknownCommandRecovery;
  }) {
    super({ ...input, message: `Command ${input.commandId} outcome is unknown: ${input.reason}` });
    this.name = "CommandUnknownError";
    this.reason = input.reason;
    this.recovery = input.recovery;
  }
}

export type ExecutionCoordinator = {
  execute(input: {
    workspace: WorkspaceRef;
    request: CommandRequest;
    runId: string;
    attemptId: string;
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

const storedProcessResultSchema = z.object({
  kind: z.enum(["completed", "failed"]),
  stdout: z.string(),
  stderr: z.string(),
  statusCode: z.number().int(),
  outputTruncated: z.boolean(),
  timedOut: z.boolean(),
  reconciledAfterTransport: z.boolean().optional(),
});

const commandMetadataSchema = z.object({
  kind: z.literal("guest-command"),
  commandId: z.string(),
  workspace: z.object({
    id: z.string(),
    threadId: z.string(),
    name: z.string(),
    provider: z.enum(["docker", "freestyle"]),
    providerId: z.string().nullable(),
    generation: z.number().int(),
  }),
  runId: z.string(),
  attemptId: z.string(),
  request: z.object({
    command: z.string(),
    timeoutMs: z.number(),
  }),
  outputMaxBytes: z.number(),
});

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Validate command result JSON loaded from PostgreSQL.
function storedProcessResult(value: unknown): StoredProcessResult | null {
  const parsed = storedProcessResultSchema.safeParse(value);

  if (!parsed.success) return null;

  return parsed.data.reconciledAfterTransport === true
    ? parsed.data
    : { ...parsed.data, reconciledAfterTransport: undefined };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Validate command metadata JSON loaded from PostgreSQL.
function commandMetadata(value: unknown): CommandMetadata | null {
  const parsed = commandMetadataSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
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
  if (
    !guestCommandStateIsSettled(observation.state) ||
    observation.statusCode === null ||
    !observation.outputAvailable
  )
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
      reconciledAfterTransport: result.reconciledAfterTransport ? true : undefined,
    };

    await store.updateCommand({
      commandId: record.commandId,
      state: result.state,
      cancellationRequested: result.cancellationRequested,
      result: stored,
    });

    return result;
  }

  async function persistUnknown(
    record: CommandOperationRecord,
    workspace: WorkspaceRef,
    reason: string,
    recovery: UnknownCommandRecovery,
  ): Promise<never> {
    await store.updateCommand({
      commandId: record.commandId,
      state: "unknown",
      cancellationRequested: record.cancellationRequested,
      result: { kind: "unknown", reason: reason.slice(0, 500), recovery },
    });
    throw new CommandUnknownError({
      workspaceId: workspace.id,
      generation: workspace.generation,
      commandId: record.commandId,
      reason,
      recovery,
    });
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
      return persistUnknown(
        record,
        workspace,
        "command ownership metadata does not match the current workspace generation",
        "quarantine-generation",
      );
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

    return persistUnknown(record, workspace, lastReason, "hold-fence");
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
    signal: AbortSignal;
  }): Promise<CoordinatedCommandResult> {
    const { workspace, request, runId, attemptId, signal } = inputValue;
    signal.throwIfAborted();

    const unsettled = await store.listUnsettledCommands({
      workspaceId: workspace.id,
      generation: workspace.generation,
    });

    if (unsettled[0])
      throw new UnresolvedCommandError({
        workspaceId: workspace.id,
        generation: workspace.generation,
        commandId: unsettled[0].commandId,
      });

    const timeoutMs = Math.max(1, request.timeoutMs ?? config.providerTimeoutMs);
    const owner = newCommandOwner({ workspace, runId, attemptId });

    const metadata: CommandMetadata = {
      kind: "guest-command",
      commandId: owner.commandId,
      workspace,
      runId,
      attemptId,
      request: { command: request.command, timeoutMs },
      outputMaxBytes,
    };

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
      return persistUnknown(
        record,
        workspace,
        "persisted command ownership metadata does not match the dispatch request",
        "quarantine-generation",
      );
    }

    if (record.state === "completed" || record.state === "failed") {
      const result = storedResult(record, record.commandId);

      if (result) return result;

      return persistUnknown(
        record,
        workspace,
        "terminal command has no guest process result",
        "quarantine-generation",
      );
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

    let cancellationRequested = false;
    let cancellationFailure: unknown;
    let cancellationUpdate: Promise<void> = Promise.resolve();

    const onAbort = () => {
      cancellationRequested = true;

      const next = cancellationUpdate.then(async () => {
        await store.updateCommand({ commandId: owner.commandId, cancellationRequested: true });
      });

      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the rejection so cancellation persistence failures remain fatal.
      cancellationUpdate = next.catch((error: unknown) => {
        cancellationFailure ??= error;
        throw error;
      });
      void cancellationUpdate.catch(() => undefined);
    };

    signal.addEventListener("abort", onAbort, { once: true });

    try {
      if (signal.aborted) return settleNotDispatched();
      const provider = providerFor(providers, workspace);

      const fencedRequest = buildGuestCommandRequest({
        owner,
        request: { ...request, timeoutMs },
        outputMaxBytes,
      });

      let response: CommandResult | undefined;
      let providerFailed = false;

      try {
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
              ...publicErrorFields(reconciliationError),
              recovery:
                reconciliationError instanceof CommandUnknownError
                  ? reconciliationError.recovery
                  : undefined,
            },
            "Command remains unresolved after provider interruption",
          );
          throw reconciliationError;
        }
      }

      const observation = parseGuestCommandObservation(response, owner);

      const immediate = processObservation(
        observation,
        owner.commandId,
        cancellationRequested,
        false,
      );

      if (immediate) return await settle(record, immediate);
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
