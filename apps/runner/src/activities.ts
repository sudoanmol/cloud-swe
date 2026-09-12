import { discoverRemoteResources, expandRemoteSkill } from "./remote-resources.js";
import { z } from "zod";
import { Effect } from "effect";
import {
  RunnerServices,
  runActivity,
  temporalFailure,
  workspaceLock,
  type ActivityRuntime,
} from "./activity-scope.js";
import { failureIdentities } from "./failure.js";
import type { PiEvent } from "./pi.js";
import type { CleanupProviderResult } from "@cloud-swe/db/thread-contracts";
import type { Logger } from "pino";
import {
  WORKSPACE_RESET_INSTRUCTION,
  type CheckpointRecord,
  type CleanupResult,
  type RunRecord,
  type WorkspaceRecord,
  type WorkspaceRef,
} from "@cloud-swe/db/thread-contracts";
import { Context } from "@temporalio/activity";
import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import type { RunnerConfig } from "./config.js";
import {
  processResult,
  type CommandRequest,
  type SandboxProvider,
  type SandboxProviders,
} from "./sandbox.js";
import { UnresolvedCommandError } from "./execution-coordinator.js";
import {
  createPiExecutor,
  PiCheckpointLimitError,
  PiCheckpointSerializationError,
  parsePiSessionMetadata,
  scopePiAttemptEvent,
  scopeScriptedAttemptEvent,
} from "./pi.js";
import { publicFailureForCode, publicFailureMessage } from "@cloud-swe/db/public-failure";
import { initializeRepository, RepositoryInitializationError } from "./repository.js";
import { runScripted as executeScripted, scriptedCheckpointSchema } from "./scripted.js";

export type PrepareWorkspaceResult =
  | { kind: "prepared"; workspace: WorkspaceRef; accessPolicy: "owner" | "demo" }
  | { kind: "cancelled" | "terminal" };

export type LifecycleResult =
  | { outcome: "completed" | "missing" }
  | { outcome: "deferred"; reason: "active-run" | "unsettled-command" };

const checkpointSummarySchema = z.object({
  generation: z.number().int().optional(),
  text: z.string().optional(),
  startedAt: z.number().optional(),
});

function checkpointContent(checkpoint: CheckpointRecord | null) {
  return checkpointSummarySchema.safeParse(checkpoint?.content).data ?? null;
}

function sessionMetadataFromCheckpoint(checkpoint: CheckpointRecord | null) {
  if (!checkpoint) return undefined;

  const metadata = parsePiSessionMetadata(checkpoint.content);

  if (!metadata) throw nonRetryable("INVALID_CHECKPOINT");

  return metadata;
}

function checkpointGeneration(checkpoint: CheckpointRecord | null): number | undefined {
  const content = checkpointContent(checkpoint);
  const value = checkpoint?.generation ?? content?.generation;

  return value !== undefined && Number.isSafeInteger(value) ? value : undefined;
}

function checkpointText(checkpoint: CheckpointRecord | null): string | undefined {
  const content = checkpointContent(checkpoint);

  return content?.text;
}

function nonRetryable(type: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(publicFailureForCode(type).message, type);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Activity rejections are decoded before checking the generation failure code.
function isWorkspaceGenerationMismatch(error: unknown): boolean {
  return failureIdentities(error).some(
    ({ code, type }) =>
      code === "WORKSPACE_GENERATION_MISMATCH" || type === "WORKSPACE_GENERATION_MISMATCH",
  );
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Recovery routing handles arbitrary activity failures and rethrows unrecognized values.
function rethrowAsReprepareIfGenerationMismatch(error: unknown): never {
  if (isWorkspaceGenerationMismatch(error)) throw nonRetryable("WORKSPACE_REPREPARE");
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

function mapCleanupResult(result: CleanupResult): LifecycleResult {
  if (result.outcome === "deferred") return { outcome: "deferred", reason: result.reason };

  if (result.outcome === "unknown")
    throw new Error("Provider outcome is unknown; workspace remains protected");

  return { outcome: result.outcome };
}

export function createActivities(
  runtime: ActivityRuntime,
  sandboxes: SandboxProviders,
  logger: Logger,
  config: RunnerConfig,
) {
  const { store, pool, coordinator } = runtime.runSync(RunnerServices);

  const sandboxFor = (provider: WorkspaceRef["provider"]): SandboxProvider => {
    const sandbox = sandboxes[provider];

    if (!sandbox) throw nonRetryable("INVALID_CONFIGURATION");

    return sandbox;
  };

  const coordinatedSandbox = (
    provider: SandboxProvider,
    runId: string,
    attemptId: string,
    ownershipToken: string,
  ) => ({
    ...provider,
    exec: async (workspace: WorkspaceRef, request: CommandRequest, signal: AbortSignal) => {
      const result = await coordinator.execute({
        workspace,
        request,
        runId,
        attemptId,
        ownershipToken,
        signal,
      });

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
    },
  });

  function withThreadWorkspaceLock<T>(threadId: string, work: (signal: AbortSignal) => Promise<T>) {
    return workspaceLock({ pool, threadId, logger }, work);
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Decode the caught attempt failure before recovery.
  function recoverAttempt(threadId: string, error: unknown) {
    if (error instanceof UnresolvedCommandError)
      return withThreadWorkspaceLock(threadId, (signal) =>
        quarantineAndReplaceHeld(threadId, error, signal),
      );

    return Effect.try({
      try: () => rethrowAsReprepareIfGenerationMismatch(error),
      catch: (cause) => cause,
    });
  }

  function executionLimit(run: RunRecord) {
    return run.accessPolicy === "owner" ? (config.ownerMaxRunMs ?? 3_600_000) : config.maxRunMs;
  }

  async function assertActive(
    runId: string,
    startedAt: number,
  ): Promise<RunRecord & { status: "queued" | "running" }> {
    const run = await store.loadRun(runId);

    if (!runIsActive(run)) throw nonRetryable("RUN_TERMINAL");

    if (run.cancelRequestedAt) throw new CancelledFailure("Cancellation requested");

    if (Date.now() - startedAt >= executionLimit(run))
      throw nonRetryable(run.accessPolicy === "owner" ? "RUN_TIMEOUT" : "DEMO_EXECUTION_DEADLINE");

    return run;
  }

  async function executionStartedAt(runId: string, ownershipToken: string): Promise<number> {
    return (await store.beginAgentExecution(runId, ownershipToken)).getTime();
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
      throw nonRetryable("WORKSPACE_REPREPARE");
    await reconcileWorkspace(workspace, signal);
    const resolved = await provider.resolve(workspaceRef(workspace), signal);

    if (resolved.disposition === "missing") throw nonRetryable("WORKSPACE_REPREPARE");

    if (workspace.provider === "freestyle") {
      const ensured = await provider.ensure(resolved.workspace, signal);

      if (ensured.disposition === "replaced") throw nonRetryable("WORKSPACE_REPREPARE");
    }

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

    if (!existing) throw nonRetryable("WORKSPACE_QUARANTINED");

    if (existing.id !== error.workspaceId || existing.generation !== error.generation)
      throw nonRetryable("WORKSPACE_REPREPARE");

    if (existing.state !== "quarantined") {
      try {
        await store.updateWorkspace({ threadId, state: "quarantined" });
      } catch (storeError) {
        logger.warn(
          { threadId, err: publicFailureMessage(storeError) },
          "Could not quarantine a workspace with an unknown command outcome",
        );
      }
    }

    const workspace = (await store.readWorkspace(threadId)) ?? existing;
    let deletion: CleanupProviderResult;

    try {
      deletion = await sandboxFor(workspace.provider).delete(workspaceRef(workspace), signal);
    } catch {
      deletion = { outcome: "unknown" };
    }

    if (deletion.outcome === "unknown") throw nonRetryable("WORKSPACE_QUARANTINED");
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
    throw nonRetryable("WORKSPACE_REPREPARE");
  }

  const prepareWorkspace = Effect.fnUntraced(function* (
    runId: string,
  ): Effect.fn.Return<PrepareWorkspaceResult, unknown> {
    const initial = yield* Effect.tryPromise({
      try: () => store.loadRun(runId),
      catch: (error) => error,
    });

    if (!initial) return { kind: "terminal" };

    return yield* withThreadWorkspaceLock(
      initial.threadId,
      async (signal): Promise<PrepareWorkspaceResult> => {
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

        let workspace = await store.readWorkspace(current.threadId);
        const wasDeleted = workspace?.state === "deleted";
        const providerName = workspace && !wasDeleted ? workspace.provider : config.sandboxProvider;

        if (config.executionMode === "pi" && providerName !== "freestyle")
          throw nonRetryable("REPOSITORY_PROVIDER_UNSUPPORTED");

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

        const { token: ownershipToken } = await store.claimExecutionOwnership({
          runId,
          attemptId,
          generation: workspace.generation,
        });

        const commandSandbox = coordinatedSandbox(provider, runId, attemptId, ownershipToken);

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
            throw nonRetryable("REPOSITORY_INITIALIZATION");

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
          ownershipToken,
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

        return {
          kind: "prepared",
          workspace: workspaceRef(workspace),
          accessPolicy: current.accessPolicy,
        };
      },
    ).pipe(Effect.catch((error) => recoverAttempt(initial.threadId, error)));
  });

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

  async function runPiLocked(runId: string, signal: AbortSignal): Promise<void> {
    const initial = await store.loadRun(runId);

    if (!runIsActive(initial)) return;
    let workspaceRecord = await store.readWorkspace(initial.threadId);

    if (!workspaceRecord) throw new Error("Workspace disappeared before Pi execution");
    const attemptId = activityAttemptId();
    const provider = sandboxFor(workspaceRecord.provider);
    workspaceRecord = await resolveExecutionWorkspace(workspaceRecord, provider, signal);

    const { token: ownershipToken } = await store.claimExecutionOwnership({
      runId,
      attemptId,
      generation: workspaceRecord.generation,
    });

    const commandSandbox = coordinatedSandbox(provider, runId, attemptId, ownershipToken);

    const resources = await discoverRemoteResources({
      sandbox: commandSandbox,
      workspace: workspaceRef(workspaceRecord),
      signal,
      outputMaxBytes: config.commandOutputMaxBytes,
    });

    if (resources.diagnostics.length)
      logger.warn({ runId, diagnostics: resources.diagnostics }, "Project skill diagnostics");

    const startedAt = await executionStartedAt(runId, ownershipToken);

    await assertActive(runId, startedAt);

    const completed = await store.loadCheckpoint({
      runId,
      key: "pi-completed",
      generation: workspaceRecord.generation,
    });

    const completedText = checkpointText(completed);

    if (completedText !== undefined) {
      await assertActive(runId, startedAt);
      await store.completeRun(runId, completedText, ownershipToken);

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

    const remaining = Math.max(1, executionLimit(initial) - (Date.now() - startedAt));
    const executionSignal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);

    const event = async (piEvent: PiEvent) => {
      const scoped = scopePiAttemptEvent(runId, attemptId, piEvent);
      await store.appendRunEvent({
        runId,
        ownershipToken,
        type: scoped.type,
        payload: scoped.payload,
        dedupeKey: scoped.dedupeKey,
      });
    };

    const executePi = createPiExecutor({
      resources,
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
          ownershipToken,
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
      logger,
    });

    let output;

    try {
      output = await executePi({
        prompt: `${resetInstruction}${continuation}Original request: ${expandRemoteSkill(initial.prompt, resources)}`,
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
        throw nonRetryable("CHECKPOINT_TOO_LARGE");
      await assertActive(runId, startedAt);
      throw error;
    }

    await assertActive(runId, startedAt);
    await store.saveCheckpoint({
      runId,
      key: "pi-completed",
      generation: workspaceRecord.generation,
      attemptId,
      ownershipToken,
      content: {
        version: 1,
        kind: "pi.completed",
        generation: workspaceRecord.generation,
        attemptId,
        text: output.text,
      },
    });
    await store.completeRun(runId, output.text, ownershipToken);
  }

  async function runScriptedLocked(runId: string, signal: AbortSignal): Promise<void> {
    const initial = await store.loadRun(runId);

    if (!runIsActive(initial)) return;
    let workspaceRecord = await store.readWorkspace(initial.threadId);

    if (!workspaceRecord) throw new Error("Workspace disappeared before scripted execution");
    const attemptId = activityAttemptId();
    const provider = sandboxFor(workspaceRecord.provider);
    workspaceRecord = await resolveExecutionWorkspace(workspaceRecord, provider, signal);

    const { token: ownershipToken } = await store.claimExecutionOwnership({
      runId,
      attemptId,
      generation: workspaceRecord.generation,
    });

    const startedAt = await executionStartedAt(runId, ownershipToken);

    await assertActive(runId, startedAt);
    const commandSandbox = coordinatedSandbox(provider, runId, attemptId, ownershipToken);

    const result = await executeScripted({
      runId,
      prompt: initial.prompt,
      workspace: workspaceRef(workspaceRecord),
      stepDelayMs: config.stepDelayMs,
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.max(1, executionLimit(initial) - (Date.now() - startedAt))),
      ]),
      execute: (workspace, request, commandSignal) =>
        commandSandbox.exec(workspace, request, commandSignal),
      emit: async (scriptedEvent) => {
        const scoped = scopeScriptedAttemptEvent(runId, attemptId, scriptedEvent);
        await store.appendRunEvent({
          runId,
          ownershipToken,
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

          return scriptedCheckpointSchema.safeParse(saved?.content).data;
        },
        save: async (key, content) => {
          await store.saveCheckpoint({
            runId,
            key,
            generation: workspaceRecord.generation,
            attemptId,
            ownershipToken,
            content: { ...content, generation: workspaceRecord.generation, attemptId },
          });
        },
      },
    });

    await assertActive(runId, startedAt);
    await store.completeRun(runId, result, ownershipToken);
  }

  const executeRun = Effect.fnUntraced(function* (runId: string, execute: typeof runPiLocked) {
    const initial = yield* Effect.tryPromise({
      try: () => store.loadRun(runId),
      catch: (error) => error,
    });

    if (!runIsActive(initial)) return;
    yield* withThreadWorkspaceLock(initial.threadId, (signal) => execute(runId, signal)).pipe(
      Effect.catch((error) => recoverAttempt(initial.threadId, error)),
    );
  });

  const runPi = (runId: string) => executeRun(runId, runPiLocked);
  const runScripted = (runId: string) => executeRun(runId, runScriptedLocked);

  const runExecution = (runId: string) =>
    config.executionMode === "pi" ? runPi(runId) : runScripted(runId);

  async function finalizeRun(
    runId: string,
    status: "failed" | "cancelled",
    error?: string,
    failureCode?: string,
  ): Promise<void> {
    const current = await store.loadRun(runId);

    if (!current || !runIsActive(current)) return;

    if (status === "cancelled" || current.cancelRequestedAt) await store.cancelRun(runId);
    else {
      const deadlineReached =
        current.agentStartedAt !== null &&
        Date.now() - current.agentStartedAt.getTime() >= executionLimit(current);

      const message = deadlineReached
        ? publicFailureForCode(
            current.accessPolicy === "owner" ? "RUN_TIMEOUT" : "DEMO_EXECUTION_DEADLINE",
          ).message
        : publicFailureMessage(error ?? "Agent execution failed");

      await store.failRun(
        runId,
        message,
        deadlineReached
          ? current.accessPolicy === "owner"
            ? "RUN_TIMEOUT"
            : "DEMO_EXECUTION_DEADLINE"
          : failureCode,
      );
    }
  }

  const adapter =
    <Args extends unknown[], Result>(
      operation: (...args: Args) => Effect.Effect<Result, unknown>,
    ) =>
    async (...args: Args): Promise<Result> => {
      const context = Context.current();

      try {
        return await runActivity(runtime, operation(...args));
      } catch (error) {
        throw temporalFailure(error, context.cancellationSignal.aborted);
      }
    };

  return {
    prepareWorkspace: adapter(prepareWorkspace),
    runPi: adapter(runPi),
    runScripted: adapter(runScripted),
    runExecution: adapter(runExecution),
    finalizeRun: adapter((...args: Parameters<typeof finalizeRun>) =>
      Effect.tryPromise({ try: () => finalizeRun(...args), catch: (error) => error }),
    ),
    pauseWorkspace: adapter((threadId: string) => {
      return withThreadWorkspaceLock(threadId, (signal) =>
        lifecycleTransition(threadId, "paused", signal),
      );
    }),
    ownerRetention: adapter((threadId: string) =>
      Effect.tryPromise({ try: () => store.threadIsOwner(threadId), catch: (error) => error }),
    ),
    deleteWorkspace: adapter((threadId: string) => {
      return withThreadWorkspaceLock(threadId, async (signal): Promise<LifecycleResult> =>
        (await store.threadIsOwner(threadId))
          ? { outcome: "completed" }
          : lifecycleTransition(threadId, "deleted", signal),
      );
    }),
  };
}
