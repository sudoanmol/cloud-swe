import type { Logger } from "pino";
import type { Pool } from "pg";
import { setTimeout as delay } from "node:timers/promises";
import type {
  CheckpointRecord,
  CleanupResult,
  RunRecord,
  ThreadStore,
  WorkspaceRecord,
  WorkspaceRef,
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
import type { ExecutionCoordinator } from "./execution-coordinator.js";
import { createPiExecutor, type PiSessionMetadata } from "./pi.js";
import { initializeRepository, RepositoryInitializationError } from "./repository.js";
import { runScripted as executeScripted } from "./scripted.js";

export type PrepareWorkspaceResult =
  | { kind: "prepared"; workspace: WorkspaceRef }
  | { kind: "cancelled" | "terminal" };

export type LifecycleResult =
  | { outcome: "completed" | "missing" }
  | { outcome: "deferred"; reason: "active-run" | "unsettled-command" }
  | { outcome: "unknown" };

const workspaceResetMessage =
  "The workspace filesystem was replaced. Uncommitted files and local, unpushed commits may be gone. Inspect the current /workspace before continuing.";

function checkpointContent(checkpoint: CheckpointRecord | null): Record<string, unknown> | null {
  const value: unknown = checkpoint?.content;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

function property(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function isPiSessionMetadata(value: unknown): value is PiSessionMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const sessionId = property(value, "sessionId");
  const provider = property(value, "provider");
  const model = property(value, "model");
  const entries = property(value, "entries");
  if (
    typeof sessionId !== "string" ||
    typeof provider !== "string" ||
    typeof model !== "string" ||
    !Array.isArray(entries)
  )
    return false;
  // Pi entries are immutable object records. Reject scalar/nullable values so
  // malformed JSON cannot be handed to SessionManager as a fake session.
  return entries.every((entry) => typeof entry === "object" && entry !== null);
}

function sessionMetadataFromCheckpoint(
  checkpoint: CheckpointRecord | null,
): PiSessionMetadata | undefined {
  const content = checkpointContent(checkpoint);
  return content && isPiSessionMetadata(content) ? content : undefined;
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

function safeDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : "Activity failed";
  return message
    .replace(
      /(authorization|cookie|token|secret|api[-_]?key|password)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/(?:\/Users\/|\/home\/|\/var\/|\/tmp\/)[^\s'"`]+/g, "[worker-path]")
    .slice(0, 500);
}

function mapCleanupResult(result: CleanupResult): LifecycleResult {
  if (result.outcome === "deferred") return { outcome: "deferred", reason: result.reason };
  if (result.outcome === "unknown") return { outcome: "unknown" };
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
      const result = await coordinator.execute({ workspace, request, runId, attemptId, signal });
      return processResult(result.stdout, result.stderr, result.statusCode, result.outputTruncated);
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

  async function pauseOtherUserWorkspaces(
    userId: string,
    currentThreadId: string,
    signal: AbortSignal,
    runId: string,
  ) {
    const others = await pool.query<WorkspaceRecord & { user_id: string }>(
      `select w.id, w.thread_id as "threadId", w.name, w.provider, w.state, w.provider_id as "providerId",
              w.generation, w.lifecycle_transition_id as "lifecycleTransitionId",
              w.lifecycle_transition_state as "lifecycleTransitionState", w.created_at as "createdAt",
              w.updated_at as "updatedAt", t.user_id
         from workspace w
         join thread t on t.id = w.thread_id
        where t.user_id = $1 and w.thread_id <> $2
          and w.state in ('running', 'provisioning', 'paused', 'recovery', 'quarantined')`,
      [userId, currentThreadId],
    );
    for (const workspace of others.rows) {
      const result = await lifecycleTransition(workspace.threadId, "paused", signal);
      if (result.outcome === "deferred")
        throw new Error(`Cannot start ${runId}; another workspace has ${result.reason}`);
      if (result.outcome === "unknown")
        throw new Error("Cannot start a run while another workspace lifecycle is ambiguous");
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
        const thread = await store.getThread({
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
          // A pending lifecycle transition represents an operation whose provider
          // outcome may be unknown. Let the durable guard retry it. When the guard
          // defers because this thread has an accepted run, that run supersedes the
          // stale idle pause/delete: the deferral recheck runs before any provider
          // mutation, so the transition provably never touched the provider and its
          // intent can be released. Unknown outcomes stay fail-closed.
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
              if (transition.outcome === "unknown")
                throw new Error("Workspace lifecycle outcome is unknown; refusing to prepare it");
              workspace = await store.readWorkspace(current.threadId);
              if (!workspace)
                throw new Error("Workspace disappeared while reconciling its lifecycle");
            }
          }
          if (workspace.state === "quarantined" || workspace.state === "recovery")
            throw new Error("Workspace is quarantined for recovery and cannot be prepared yet");
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
            reason: workspaceResetMessage,
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
        await coordinator.reconcileUnsettled({ workspace: workspaceRef(workspace), signal });
        const commandSandbox = coordinatedSandbox(provider, runId, attemptId);
        try {
          const repositoryOptions = {
            // Repository code only uses exec; this adapter prevents it from
            // bypassing command_operation and guest fencing.
            sandbox: commandSandbox,
            workspace: workspaceRef(workspace),
            repositoryUrl: thread.repositoryUrl,
            repositoryBranch: thread.repositoryBranch,
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
              repositoryUrl: thread.repositoryUrl,
              repositoryBranch: thread.repositoryBranch,
              repositoryState,
              generation: workspace.generation,
            },
            "Workspace repository initialized",
          );
        } catch (error) {
          if (error instanceof RepositoryInitializationError && error.nonRetryable)
            throw nonRetryable(safeDiagnostic(error), "REPOSITORY_INITIALIZATION");
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
      // A concurrent generation bump (reset) makes staged checkpoint or
      // workspace writes fail closed. Route back through preparation instead
      // of failing the run against a stale filesystem.
      rethrowAsReprepareIfGenerationMismatch(error);
    }
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
    const checkpointGeneration = checkpointGenerationOf(sessionCheckpoint);
    const replacedFilesystem =
      checkpointGeneration !== undefined && checkpointGeneration < workspaceRecord.generation;
    const sessionMetadata = replacedFilesystem
      ? undefined
      : sessionMetadataFromCheckpoint(sessionCheckpoint);
    const resetInstruction = replacedFilesystem ? `${workspaceResetMessage}\n\n` : "";
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
      await store.appendRunEvent({
        runId,
        type: piEvent.type,
        payload: { runId, attemptId, ...piEvent.payload },
        dedupeKey: `run:${runId}:attempt:${attemptId}:${piEvent.dedupeKey}`,
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
            generation: workspaceRecord.generation,
            attemptId,
            ...metadata,
          },
        });
      },
    });
    const output = await executePi({
      prompt: `${resetInstruction}${continuation}Original request: ${initial.prompt}`,
      runId,
      signal: executionSignal,
      sessionEntries: sessionMetadata?.entries,
      workspace: workspaceRef(workspaceRecord),
    });
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
        await store.appendRunEvent({
          runId,
          type: scriptedEvent.type,
          payload: { runId, attemptId, ...scriptedEvent.payload },
          dedupeKey: `run:${runId}:attempt:${attemptId}:${scriptedEvent.dedupeKey}`,
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
      rethrowAsReprepareIfGenerationMismatch(error);
    }
  }

  async function runScripted(runId: string): Promise<void> {
    const initial = await store.loadRun(runId);
    if (!runIsActive(initial)) return;
    try {
      await withUserWorkspaceLock(initial.threadId, (signal) => runScriptedLocked(runId, signal));
    } catch (error) {
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
    const initial = await store.loadRun(runId);
    if (!initial) return;
    await withUserWorkspaceLock(initial.threadId, async (signal) => {
      const current = await store.loadRun(runId);
      if (!current || !runIsActive(current)) return;
      const workspace = await store.readWorkspace(current.threadId);
      if (workspace && workspace.state !== "deleted") await reconcileWorkspace(workspace, signal);
      if (status === "cancelled" || current.cancelRequestedAt) await store.cancelRun(runId);
      else await store.failRun(runId, (error ?? "Agent execution failed").slice(0, 500));
    });
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

function checkpointGenerationOf(checkpoint: CheckpointRecord | null): number | undefined {
  return checkpointGeneration(checkpoint);
}
