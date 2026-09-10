import type { Logger } from "pino";
import type { Pool } from "pg";
import { setTimeout as delay } from "node:timers/promises";
import {
  WORKSPACE_RESET_INSTRUCTION,
  type CheckpointRecord,
  type CleanupResult,
  type RunRecord,
  type ThreadStore,
  type WorkspaceRecord,
  type WorkspaceRef,
} from "@cloud-swe/db/thread-contracts";
import { Context, heartbeat } from "@temporalio/activity";
import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import type { RunnerConfig } from "./config.js";
import {
  processResult,
  type CommandRequest,
  type SandboxProvider,
  type SandboxProviders,
} from "./sandbox.js";
import { UnresolvedCommandError, type ExecutionCoordinator } from "./execution-coordinator.js";
import {
  coordinatorTransport,
  createPiExecutor,
  PiCheckpointLimitError,
  PiCheckpointSerializationError,
  piSessionMetadataFromContent,
  scopePiAttemptEvent,
  scopeScriptedAttemptEvent,
} from "./pi.js";
import { sanitizeFailureMessage } from "./pi-writer.js";
import { initializeRepository, RepositoryInitializationError } from "./repository.js";
import { runScripted as executeScripted } from "./scripted.js";

export type PrepareWorkspaceResult =
  | { kind: "prepared"; workspace: WorkspaceRef }
  | { kind: "cancelled" | "terminal" };

export type LifecycleResult =
  | { outcome: "completed" | "missing" }
  | { outcome: "deferred"; reason: "active-run" | "unsettled-command" };

function checkpointContent(checkpoint: CheckpointRecord | null): Record<string, unknown> | null {
  const value: unknown = checkpoint?.content;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

function sessionMetadataFromCheckpoint(checkpoint: CheckpointRecord | null) {
  return piSessionMetadataFromContent(checkpoint?.content);
}

function checkpointGeneration(checkpoint: CheckpointRecord | null): number | undefined {
  const content = checkpointContent(checkpoint);
  const value = checkpoint?.generation ?? content?.generation;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function checkpointText(checkpoint: CheckpointRecord | null): string | undefined {
  const content = checkpointContent(checkpoint);
  return typeof content?.text === "string" ? content.text : undefined;
}

function nonRetryable(message: string, type: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(message.slice(0, 500), type);
}

function isWorkspaceGenerationMismatch(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    const code = Reflect.get(current, "code");
    if (code === "WORKSPACE_GENERATION_MISMATCH") return true;
    const type = Reflect.get(current, "type");
    if (type === "WORKSPACE_GENERATION_MISMATCH") return true;
    const cause = Reflect.get(current, "cause");
    if (cause === undefined || cause === current) return false;
    current = cause;
  }
  return false;
}

function rethrowAsReprepareIfGenerationMismatch(error: unknown): never {
  if (isWorkspaceGenerationMismatch(error))
    throw nonRetryable(
      "Workspace generation changed; preparation is required before execution can continue",
      "WORKSPACE_REPREPARE",
    );
  throw error;
}

function runIsActive(run: RunRecord | null): run is RunRecord & { status: "queued" | "running" } {
  return run !== null && (run.status === "queued" || run.status === "running");
}

function activityAttemptId(): string {
  const info = Context.current().info;
  return `${info.activityId}:${info.attempt}`;
}

function workspaceRef(workspace: WorkspaceRecord): WorkspaceRef {
  return {
    id: workspace.id,
    threadId: workspace.threadId,
    name: workspace.name,
    provider: workspace.provider,
    providerId: workspace.providerId,
    generation: workspace.generation,
  };
}

/**
 * Pause one other workspace of the same user before a run starts. An unknown
 * command in that workspace must recover that workspace (quarantine, delete,
 * replace) instead of failing this run forever: its thread may be idle, so
 * no other worker would ever retry the recovery. Runs under the user's
 * workspace lock, so recovery uses the held-lock variant.
 */
export async function pauseOtherWorkspace(
  transition: (threadId: string) => Promise<LifecycleResult>,
  recover: (threadId: string, error: UnresolvedCommandError) => Promise<never>,
  workspace: { threadId: string },
  runId: string,
): Promise<void> {
  let result: LifecycleResult;
  try {
    result = await transition(workspace.threadId);
  } catch (error) {
    if (error instanceof UnresolvedCommandError) await recover(workspace.threadId, error);
    throw error;
  }
  if (result.outcome === "deferred")
    throw new Error(`Cannot start ${runId}; another workspace has ${result.reason}`);
}

function mapCleanupResult(result: CleanupResult): LifecycleResult {
  if (result.outcome === "deferred") return { outcome: "deferred", reason: result.reason };
  if (result.outcome === "unknown")
    throw new Error("Provider outcome is unknown; workspace remains protected");
  return { outcome: result.outcome };
}

export function createActivities(
  store: ThreadStore,
  sandboxes: SandboxProviders,
  logger: Logger,
  pool: Pool,
  config: RunnerConfig,
  coordinator: ExecutionCoordinator,
) {
  const sandboxFor = (provider: WorkspaceRef["provider"]): SandboxProvider => {
    const sandbox = sandboxes[provider];
    if (!sandbox)
      throw nonRetryable(
        `Sandbox provider ${provider} is not configured on this worker`,
        "INVALID_CONFIGURATION",
      );
    return sandbox;
  };

  const coordinatedSandbox = (provider: SandboxProvider, runId: string, attemptId: string) => ({
    ...provider,
    exec: async (workspace: WorkspaceRef, request: CommandRequest, signal: AbortSignal) => {
      try {
        const result = await coordinator.execute({ workspace, request, runId, attemptId, signal });
        const notes = [
          result.timedOut ? "guest command timed out" : "",
          result.cancellationRequested ? "cancellation was requested" : "",
          result.reconciledAfterTransport ? "settled by reconciliation after transport loss" : "",
        ].filter(Boolean);
        const stderr =
          notes.length > 0
            ? result.stderr
              ? `${result.stderr}\n[${notes.join("; ")}]`
              : `[${notes.join("; ")}]`
            : result.stderr;
        return processResult(result.stdout, stderr, result.statusCode, result.outputTruncated);
      } catch (error) {
        const transport = coordinatorTransport(error);
        if (transport) return transport;
        throw error;
      }
    },
  });

  async function withUserWorkspaceLock<T>(
    threadId: string,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const context = Context.current();
    const failure = new AbortController();
    const signal = AbortSignal.any([context.cancellationSignal, failure.signal]);
    const pulse = () => {
      try {
        heartbeat({ threadId });
      } catch (error) {
        failure.abort(error);
      }
    };
    const client = await pool.connect();
    pulse();
    const timer = setInterval(pulse, 1_000);
    const connectionLost = (error: Error) => failure.abort(error);
    client.on("error", connectionLost);
    let locked = false;
    let lockKey = "";
    try {
      const owner = await client.query<{ user_id: string }>(
        "select user_id from thread where id = $1",
        [threadId],
      );
      if (!owner.rows[0]) return await work(signal);
      lockKey = `workspace-user:${owner.rows[0].user_id}`;
      while (!locked) {
        signal.throwIfAborted();
        const result = await client.query<{ locked: boolean }>(
          "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
          [lockKey],
        );
        locked = result.rows[0]?.locked === true;
        if (!locked) await delay(100, undefined, { signal });
      }
      signal.throwIfAborted();
      return await work(signal);
    } catch (error) {
      if (context.cancellationSignal.aborted) throw new CancelledFailure("Run cancelled");
      throw error;
    } finally {
      clearInterval(timer);
      client.off("error", connectionLost);
      if (locked && !failure.signal.aborted) {
        try {
          await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
        } catch {
          failure.abort();
        }
      }
      client.release(failure.signal.aborted);
    }
  }

  async function assertActive(
    runId: string,
    startedAt: number,
  ): Promise<RunRecord & { status: "queued" | "running" }> {
    const run = await store.loadRun(runId);
    if (!runIsActive(run)) throw nonRetryable("Run is no longer active", "RUN_TERMINAL");
    if (run.cancelRequestedAt) throw new CancelledFailure("Cancellation requested");
    if (Date.now() - startedAt >= config.maxRunMs)
      throw nonRetryable("Run exceeded its active time limit", "RUN_TIMEOUT");
    return run;
  }

  async function executionStartedAt(
    runId: string,
    generation: number,
    attemptId: string,
  ): Promise<number> {
    const existing = await store.loadCheckpoint({ runId, key: "execution-started" });
    const content = checkpointContent(existing);
    const value = content?.startedAt;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    const startedAt = Date.now();
    await store.saveCheckpoint({
      runId,
      key: "execution-started",
      generation,
      attemptId,
      content: { version: 1, kind: "execution-started", startedAt },
    });
    return startedAt;
  }

  async function resolveExecutionWorkspace(
    workspace: WorkspaceRecord,
    provider: SandboxProvider,
    signal: AbortSignal,
  ): Promise<WorkspaceRecord> {
    if (
      workspace.state === "deleted" ||
      workspace.state === "recovery" ||
      workspace.state === "quarantined" ||
      workspace.lifecycleTransitionId
    )
      throw nonRetryable(
        "Workspace must be prepared before execution can continue",
        "WORKSPACE_REPREPARE",
      );
    await reconcileWorkspace(workspace, signal);
    const resolved = await provider.resolve(workspaceRef(workspace), signal);
    if (resolved.disposition === "missing")
      throw nonRetryable(
        "Workspace provider resource is missing; preparation is required before execution",
        "WORKSPACE_REPREPARE",
      );
    if (resolved.recovered && resolved.workspace.providerId) {
      return store.persistRecoveredProviderId({
        workspaceId: workspace.id,
        providerId: resolved.workspace.providerId,
      });
    }
    return workspace;
  }

  async function reconcileWorkspace(workspace: WorkspaceRecord, signal: AbortSignal) {
    const ref = workspaceRef(workspace);
    await coordinator.reconcileUnsettled({ workspace: ref, signal });
  }

  async function recoverProviderIdentity(
    workspace: WorkspaceRecord,
    provider: SandboxProvider,
    signal: AbortSignal,
  ): Promise<WorkspaceRecord> {
    const resolution = await provider.resolve(workspaceRef(workspace), signal);
    if (!resolution.recovered || !resolution.workspace.providerId) return workspace;
    return store.persistRecoveredProviderId({
      workspaceId: workspace.id,
      providerId: resolution.workspace.providerId,
    });
  }

  async function lifecycleTransition(
    threadId: string,
    targetState: "paused" | "deleted",
    signal: AbortSignal,
  ): Promise<LifecycleResult> {
    const existing = await store.readWorkspace(threadId);
    if (!existing || existing.state === "deleted") return { outcome: "completed" };
    const begun = await store.beginLifecycleTransition({
      threadId,
      state: targetState,
      transitionId: existing.lifecycleTransitionId ?? undefined,
    });
    let workspace = begun.workspace;
    const provider = sandboxFor(workspace.provider);
    workspace = await recoverProviderIdentity(workspace, provider, signal);
    await reconcileWorkspace(workspace, signal);
    const cleanup = await store.cleanupWorkspace({
      threadId,
      transitionId: begun.transitionId,
      targetState,
      mutate: async (lockedWorkspace) => {
        const ref = workspaceRef(lockedWorkspace);
        const resolution =
          targetState === "paused"
            ? await provider.pause(ref, signal)
            : await provider.delete(ref, signal);
        if (resolution.outcome === "completed")
          return { outcome: "completed", providerId: resolution.providerId ?? null };
        if (resolution.outcome === "missing") return { outcome: "missing", providerId: null };
        return { outcome: "unknown", providerId: resolution.providerId ?? null };
      },
    });
    if (cleanup.outcome === "unknown")
      throw new Error(`Provider ${targetState} outcome is unknown; workspace remains protected`);
    return mapCleanupResult(cleanup);
  }

  // The caller must hold the per-user workspace advisory lock. The provider
  // mutation and generation bump belong to one locked recovery operation.
  async function quarantineAndReplaceHeld(
    threadId: string,
    error: UnresolvedCommandError,
    signal: AbortSignal,
  ): Promise<never> {
    const existing = await store.readWorkspace(threadId);
    if (!existing)
      throw nonRetryable(
        `Workspace is quarantined: command ${error.commandId} has an unknown outcome`,
        "WORKSPACE_QUARANTINED",
      );
    if (existing.id !== error.workspaceId || existing.generation !== error.generation)
      throw nonRetryable(
        "Workspace generation changed; preparation is required before execution can continue",
        "WORKSPACE_REPREPARE",
      );
    if (existing.state !== "quarantined") {
      try {
        await store.updateWorkspace({ threadId, state: "quarantined" });
      } catch (storeError) {
        logger.warn(
          { threadId, err: sanitizeFailureMessage(storeError) },
          "Could not quarantine a workspace with an unknown command outcome",
        );
      }
    }
    const workspace = (await store.readWorkspace(threadId)) ?? existing;
    let deletion: { outcome: string; providerId?: string | null };
    try {
      deletion = await sandboxFor(workspace.provider).delete(workspaceRef(workspace), signal);
    } catch {
      deletion = { outcome: "unknown" };
    }
    if (deletion.outcome === "unknown")
      throw nonRetryable(
        `Workspace is quarantined: command ${error.commandId} has an unknown outcome and provider deletion is ambiguous`,
        "WORKSPACE_QUARANTINED",
      );
    await store.resetWorkspace({
      threadId,
      expectedGeneration: workspace.generation,
      transitionId: `unknown-command:${error.commandId}`,
      reason: WORKSPACE_RESET_INSTRUCTION,
      providerId: null,
      confirmedMissing: true,
      state: "provisioning",
    });
    logger.warn(
      { threadId, commandId: error.commandId },
      "Unknown command outcome replaced the workspace filesystem; preparation must rerun",
    );
    throw nonRetryable(
      "Workspace generation changed; preparation is required before execution can continue",
      "WORKSPACE_REPREPARE",
    );
  }

  async function pauseOtherUserWorkspaces(
    userId: string,
    currentThreadId: string,
    signal: AbortSignal,
    runId: string,
  ) {
    const others = await store.listOtherUserWorkspaces({
      userId,
      threadId: currentThreadId,
    });
    for (const workspace of others) {
      await pauseOtherWorkspace(
        (threadId) => lifecycleTransition(threadId, "paused", signal),
        (threadId, error) => quarantineAndReplaceHeld(threadId, error, signal),
        workspace,
        runId,
      );
    }
  }

  async function prepareWorkspace(runId: string): Promise<PrepareWorkspaceResult> {
    const initial = await store.loadRun(runId);
    if (!initial) return { kind: "terminal" };
    try {
      return await withUserWorkspaceLock(initial.threadId, async (signal) => {
        const current = await store.loadRun(runId);
        if (!runIsActive(current)) return { kind: "terminal" };
        if (current.cancelRequestedAt) {
          await store.cancelRun(runId);
          return { kind: "cancelled" };
        }
        const repository = await store.readRepository({
          userId: current.userId,
          threadId: current.threadId,
        });
        await store.startRun(runId);
        const started = await store.loadRun(runId);
        if (!runIsActive(started)) return { kind: "terminal" };
        await pauseOtherUserWorkspaces(current.userId, current.threadId, signal, runId);

        let workspace = await store.readWorkspace(current.threadId);
        const wasDeleted = workspace?.state === "deleted";
        const providerName = workspace && !wasDeleted ? workspace.provider : config.sandboxProvider;
        if (config.executionMode === "pi" && providerName !== "freestyle")
          throw nonRetryable(
            "Repository-backed Pi execution requires the Freestyle provider",
            "REPOSITORY_PROVIDER_UNSUPPORTED",
          );
        if (!workspace) {
          workspace = await store.updateWorkspace({
            threadId: current.threadId,
            state: "provisioning",
            provider: providerName,
            generation: 1,
          });
        } else {
          // A deferred idle transition never reached the provider, so an
          // accepted run supersedes it. Unknown outcomes stay fail-closed.
          if (workspace.lifecycleTransitionId) {
            const target = workspace.lifecycleTransitionState;
            if (target !== "paused" && target !== "deleted")
              throw new Error("Workspace has an invalid pending lifecycle transition");
            const pendingTransitionId = workspace.lifecycleTransitionId;
            const transition = await lifecycleTransition(current.threadId, target, signal);
            if (transition.outcome === "deferred" && transition.reason === "active-run") {
              workspace = await store.cancelLifecycleTransition({
                threadId: current.threadId,
                transitionId: pendingTransitionId,
              });
              logger.info(
                { runId, threadId: current.threadId, target },
                "Accepted run supersedes a deferred idle lifecycle transition",
              );
            } else {
              if (transition.outcome === "deferred")
                throw new Error(`Workspace lifecycle is deferred by ${transition.reason}`);
              workspace = await store.readWorkspace(current.threadId);
              if (!workspace)
                throw new Error("Workspace disappeared while reconciling its lifecycle");
            }
          }
          if (workspace.state === "quarantined" || workspace.state === "recovery")
            workspace = await recoverQuarantinedWorkspace(current.threadId, workspace, signal);
          // Every retry reconciles unsettled operations before ensure, including
          // provisioning rows. A preparation checkpoint is informational only.
          await reconcileWorkspace(workspace, signal);
          if (workspace.state !== "provisioning") {
            workspace = await store.updateWorkspace({
              threadId: current.threadId,
              state: "provisioning",
              provider: providerName,
              providerId: workspace.providerId,
              generation: workspace.generation,
            });
          }
        }

        if (!workspace) throw new Error("Workspace record disappeared during preparation");
        const preparedWorkspace = workspace;
        const provider = sandboxFor(preparedWorkspace.provider);
        const ensured = await provider.ensure(workspaceRef(preparedWorkspace), signal);
        const replacement =
          ensured.disposition === "replaced" || (wasDeleted && ensured.disposition === "created");
        if (replacement) {
          // A `replaced` disposition (or a fresh create after a confirmed
          // delete) means the provider confirms the old filesystem is gone.
          // Reset is fail-closed without that confirmation, so only reach here
          // when the provider has established a new filesystem.
          const resetInput = {
            threadId: current.threadId,
            expectedGeneration: workspace.generation,
            transitionId: `reset:${workspace.id}:${workspace.generation}:${ensured.providerId}`,
            reason: WORKSPACE_RESET_INSTRUCTION,
            providerId: ensured.providerId,
            confirmedMissing: true,
            state: "provisioning" as const,
          };
          let reset: Awaited<ReturnType<typeof store.resetWorkspace>> | undefined;
          try {
            reset = await store.resetWorkspace(resetInput);
          } catch (error) {
            rethrowAsReprepareIfGenerationMismatch(error);
          }
          if (!reset) throw new Error("Workspace reset did not return a workspace");
          workspace = reset.workspace;
          logger.warn(
            {
              runId,
              threadId: current.threadId,
              oldGeneration: reset.oldGeneration,
              newGeneration: reset.newGeneration,
            },
            "Workspace filesystem reset; resuming from the new generation",
          );
        } else {
          workspace = await store.updateWorkspace({
            threadId: current.threadId,
            state: "provisioning",
            provider: workspace.provider,
            providerId: ensured.providerId,
            generation: workspace.generation,
          });
        }

        const attemptId = activityAttemptId();
        const commandSandbox = coordinatedSandbox(provider, runId, attemptId);
        try {
          const repositoryOptions = {
            // Repository code only uses exec; this adapter prevents it from
            // bypassing command_operation and guest fencing.
            sandbox: commandSandbox,
            workspace: workspaceRef(workspace),
            repositoryUrl: repository.repositoryUrl,
            repositoryBranch: repository.repositoryBranch,
            cloneTimeoutMs: config.repositoryCloneTimeoutMs,
            maxBytes: config.repositoryMaxBytes,
            minFreeBytes: config.repositoryMinFreeBytes,
            signal,
          };
          const repositoryState = await initializeRepository(repositoryOptions);
          logger.info(
            {
              runId,
              threadId: current.threadId,
              repositoryUrl: repository.repositoryUrl,
              repositoryBranch: repository.repositoryBranch,
              repositoryState,
              generation: workspace.generation,
            },
            "Workspace repository initialized",
          );
        } catch (error) {
          if (error instanceof RepositoryInitializationError && error.nonRetryable)
            throw nonRetryable(sanitizeFailureMessage(error), "REPOSITORY_INITIALIZATION");
          if (error instanceof UnresolvedCommandError)
            await quarantineAndReplaceHeld(current.threadId, error, signal);
          throw error;
        }
        workspace = await store.updateWorkspace({
          threadId: current.threadId,
          state: "running",
          provider: workspace.provider,
          providerId: workspace.providerId,
          generation: workspace.generation,
        });
        await store.saveCheckpoint({
          runId,
          key: "workspace-prepared",
          generation: workspace.generation,
          attemptId,
          content: {
            version: 1,
            kind: "workspace-prepared",
            provider: workspace.provider,
            providerId: workspace.providerId,
            generation: workspace.generation,
          },
        });
        return { kind: "prepared", workspace: workspaceRef(workspace) };
      });
    } catch (error) {
      if (error instanceof UnresolvedCommandError)
        await quarantineAndReplaceLocked(
          initial.threadId,
          error,
          Context.current().cancellationSignal,
        );
      rethrowAsReprepareIfGenerationMismatch(error);
    }
  }

  async function recoverQuarantinedWorkspace(
    threadId: string,
    workspace: WorkspaceRecord,
    signal: AbortSignal,
  ): Promise<WorkspaceRecord> {
    try {
      await coordinator.reconcileUnsettled({ workspace: workspaceRef(workspace), signal });
    } catch (error) {
      if (error instanceof UnresolvedCommandError)
        await quarantineAndReplaceHeld(threadId, error, signal);
      throw error;
    }
    const next = await store.updateWorkspace({
      threadId,
      state: "provisioning",
      provider: workspace.provider,
      providerId: workspace.providerId,
      generation: workspace.generation,
    });
    logger.info(
      { threadId, generation: workspace.generation },
      "Workspace quarantine cleared after command reconciliation",
    );
    return next;
  }

  async function quarantineAndReplaceLocked(
    threadId: string,
    error: UnresolvedCommandError,
    signal: AbortSignal,
  ): Promise<never> {
    return withUserWorkspaceLock(threadId, (lockSignal) =>
      quarantineAndReplaceHeld(threadId, error, AbortSignal.any([signal, lockSignal])),
    );
  }

  async function runPiLocked(runId: string, signal: AbortSignal): Promise<void> {
    const initial = await store.loadRun(runId);
    if (!runIsActive(initial)) return;
    let workspaceRecord = await store.readWorkspace(initial.threadId);
    if (!workspaceRecord) throw new Error("Workspace disappeared before Pi execution");
    const attemptId = activityAttemptId();
    const provider = sandboxFor(workspaceRecord.provider);
    workspaceRecord = await resolveExecutionWorkspace(workspaceRecord, provider, signal);
    const startedAt = await executionStartedAt(runId, workspaceRecord.generation, attemptId);
    await assertActive(runId, startedAt);
    const commandSandbox = coordinatedSandbox(provider, runId, attemptId);
    const completed = await store.loadCheckpoint({
      runId,
      key: "pi-completed",
      generation: workspaceRecord.generation,
    });
    const completedText = checkpointText(completed);
    if (completedText !== undefined) {
      await assertActive(runId, startedAt);
      await store.completeRun(runId, completedText);
      return;
    }

    const retryCheckpoint = await store.loadCheckpoint({ runId, key: "pi-session" });
    const sessionCheckpoint =
      retryCheckpoint ??
      (await store.loadLatestCheckpoint({ threadId: initial.threadId, key: "pi-session" }));
    const sessionGeneration = checkpointGeneration(sessionCheckpoint);
    const replacedFilesystem =
      sessionGeneration !== undefined && sessionGeneration < workspaceRecord.generation;
    const sessionMetadata = sessionMetadataFromCheckpoint(sessionCheckpoint);
    const resetInstruction = replacedFilesystem ? `${WORKSPACE_RESET_INSTRUCTION}\n\n` : "";
    const continuation = retryCheckpoint
      ? "Continue the interrupted task from the current workspace state.\n\n"
      : "";
    const remaining = Math.max(1, config.maxRunMs - (Date.now() - startedAt));
    const executionSignal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
    const event = async (piEvent: {
      type: string;
      dedupeKey: string;
      payload: Record<string, unknown>;
    }) => {
      const scoped = scopePiAttemptEvent(runId, attemptId, piEvent);
      await store.appendRunEvent({
        runId,
        type: scoped.type,
        payload: scoped.payload,
        dedupeKey: scoped.dedupeKey,
      });
    };
    const executePi = createPiExecutor({
      // The sandbox adapter is coordinator-backed and never invokes
      // provider.exec itself.
      sandbox: commandSandbox,
      workspace: workspaceRef(workspaceRecord),
      piProvider: config.piProvider,
      piModel: config.piModel,
      thinkingLevel: config.piThinkingLevel,
      aiGatewayApiKey: config.aiGatewayApiKey ?? "",
      emit: event,
      checkpoint: async (metadata) => {
        await store.saveCheckpoint({
          runId,
          key: "pi-session",
          generation: workspaceRecord.generation,
          attemptId,
          content: {
            version: 1,
            kind: "pi",
            ...metadata,
            generation: workspaceRecord.generation,
            attemptId,
          },
        });
      },
    });
    let output;
    try {
      output = await executePi({
        prompt: `${resetInstruction}${continuation}Original request: ${initial.prompt}`,
        runId,
        attemptId,
        workspaceGeneration: workspaceRecord.generation,
        outputMaxBytes: config.commandOutputMaxBytes,
        checkpointMaxBytes: config.checkpointMaxBytes,
        signal: executionSignal,
        sessionEntries: sessionMetadata?.entries,
        workspace: workspaceRef(workspaceRecord),
      });
    } catch (error) {
      if (
        error instanceof PiCheckpointLimitError ||
        error instanceof PiCheckpointSerializationError
      )
        throw nonRetryable(sanitizeFailureMessage(error), "CHECKPOINT_TOO_LARGE");
      throw error;
    }
    await assertActive(runId, startedAt);
    await store.saveCheckpoint({
      runId,
      key: "pi-completed",
      generation: workspaceRecord.generation,
      attemptId,
      content: {
        version: 1,
        kind: "pi.completed",
        generation: workspaceRecord.generation,
        attemptId,
        text: output.text,
      },
    });
    await store.completeRun(runId, output.text);
  }

  async function runScriptedLocked(runId: string, signal: AbortSignal): Promise<void> {
    const initial = await store.loadRun(runId);
    if (!runIsActive(initial)) return;
    let workspaceRecord = await store.readWorkspace(initial.threadId);
    if (!workspaceRecord) throw new Error("Workspace disappeared before scripted execution");
    const attemptId = activityAttemptId();
    const provider = sandboxFor(workspaceRecord.provider);
    workspaceRecord = await resolveExecutionWorkspace(workspaceRecord, provider, signal);
    const startedAt = await executionStartedAt(runId, workspaceRecord.generation, attemptId);
    await assertActive(runId, startedAt);
    const commandSandbox = coordinatedSandbox(provider, runId, attemptId);
    const result = await executeScripted({
      runId,
      prompt: initial.prompt,
      workspace: workspaceRef(workspaceRecord),
      stepDelayMs: config.stepDelayMs,
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.max(1, config.maxRunMs - (Date.now() - startedAt))),
      ]),
      execute: (workspace, request, commandSignal) =>
        commandSandbox.exec(workspace, request, commandSignal),
      emit: async (scriptedEvent) => {
        const scoped = scopeScriptedAttemptEvent(runId, attemptId, scriptedEvent);
        await store.appendRunEvent({
          runId,
          type: scoped.type,
          payload: scoped.payload,
          dedupeKey: scoped.dedupeKey,
        });
      },
      checkpoint: {
        load: async (key) => {
          const saved = await store.loadCheckpoint({
            runId,
            key,
            generation: workspaceRecord.generation,
          });
          return checkpointContent(saved) ?? undefined;
        },
        save: async (key, content) => {
          await store.saveCheckpoint({
            runId,
            key,
            generation: workspaceRecord.generation,
            attemptId,
            content: { ...content, generation: workspaceRecord.generation, attemptId },
          });
        },
      },
    });
    await assertActive(runId, startedAt);
    await store.completeRun(runId, result);
  }

  async function runPi(runId: string): Promise<void> {
    const initial = await store.loadRun(runId);
    if (!runIsActive(initial)) return;
    try {
      await withUserWorkspaceLock(initial.threadId, (signal) => runPiLocked(runId, signal));
    } catch (error) {
      if (error instanceof UnresolvedCommandError)
        await quarantineAndReplaceLocked(
          initial.threadId,
          error,
          Context.current().cancellationSignal,
        );
      rethrowAsReprepareIfGenerationMismatch(error);
    }
  }

  async function runScripted(runId: string): Promise<void> {
    const initial = await store.loadRun(runId);
    if (!runIsActive(initial)) return;
    try {
      await withUserWorkspaceLock(initial.threadId, (signal) => runScriptedLocked(runId, signal));
    } catch (error) {
      if (error instanceof UnresolvedCommandError)
        await quarantineAndReplaceLocked(
          initial.threadId,
          error,
          Context.current().cancellationSignal,
        );
      rethrowAsReprepareIfGenerationMismatch(error);
    }
  }

  async function runExecution(runId: string): Promise<void> {
    if (config.executionMode === "pi") return runPi(runId);
    if (config.executionMode === "scripted") return runScripted(runId);
    const mode: never = config.executionMode;
    throw nonRetryable(
      `Unsupported runner execution mode: ${String(mode)}`,
      "INVALID_CONFIGURATION",
    );
  }

  async function finalizeRun(
    runId: string,
    status: "failed" | "cancelled",
    error?: string,
  ): Promise<void> {
    const current = await store.loadRun(runId);
    if (!current || !runIsActive(current)) return;
    if (status === "cancelled" || current.cancelRequestedAt) await store.cancelRun(runId);
    else await store.failRun(runId, sanitizeFailureMessage(error ?? "Agent execution failed"));
  }

  return {
    prepareWorkspace,
    runPi,
    runScripted,
    runExecution,
    finalizeRun,
    async pauseWorkspace(threadId: string): Promise<LifecycleResult> {
      return withUserWorkspaceLock(threadId, (signal) =>
        lifecycleTransition(threadId, "paused", signal),
      );
    },
    async deleteWorkspace(threadId: string): Promise<LifecycleResult> {
      return withUserWorkspaceLock(threadId, (signal) =>
        lifecycleTransition(threadId, "deleted", signal),
      );
    },
  };
}
