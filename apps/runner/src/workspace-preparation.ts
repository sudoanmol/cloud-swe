import { Effect } from "effect";
import { WORKSPACE_RESET_INSTRUCTION, type WorkspaceRecord } from "@cloud-swe/db/thread-contracts";
import { createGitBrokerClient, createPiGitTools } from "./git-tools.js";
import {
  activityAttemptId,
  nonRetryable,
  requireModelCredentials,
  rethrowAsReprepareIfGenerationMismatch,
  runIsActive,
  workspaceRef,
  type ActiveRun,
  type ActivityContext,
  type PrepareWorkspaceResult,
} from "./activity-support.js";
import { UnresolvedCommandError } from "./execution-coordinator.js";
import { initializeRepository, RepositoryInitializationError } from "./repository.js";
import type { SandboxProvider } from "./sandbox.js";
import type { WorkspaceLifecycle } from "./workspace-lifecycle.js";

type Repository = Awaited<ReturnType<ActivityContext["store"]["readRepository"]>>;

type Admission =
  | { kind: "stop"; result: PrepareWorkspaceResult }
  | { kind: "admitted"; current: ActiveRun; repository: Repository };

/** Builds the `prepareWorkspace` activity: admit the run, provision or recover its workspace, clone. */
export function createPrepareWorkspace(ctx: ActivityContext, lifecycle: WorkspaceLifecycle) {
  const { store, logger, config } = ctx;

  /** Starts the run, or reports why it should not start (terminal or cancelled). */
  async function admitRun(runId: string): Promise<Admission> {
    const current = await store.loadRun(runId);

    if (!runIsActive(current)) return { kind: "stop", result: { kind: "terminal" } };

    if (current.cancelRequestedAt) {
      await store.cancelRun(runId);

      return { kind: "stop", result: { kind: "cancelled" } };
    }

    if (config.executionMode === "pi") await requireModelCredentials(ctx, current);

    const repository = await store.readRepository({
      userId: current.userId,
      threadId: current.threadId,
    });

    await store.startRun(runId);
    const started = await store.loadRun(runId);

    if (!runIsActive(started)) return { kind: "stop", result: { kind: "terminal" } };

    return { kind: "admitted", current, repository };
  }

  /**
   * A deferred idle transition never reached the provider, so an accepted run
   * supersedes it. Unknown outcomes stay fail-closed.
   */
  async function settlePendingTransition(
    runId: string,
    threadId: string,
    workspace: WorkspaceRecord,
    pendingTransitionId: string,
    signal: AbortSignal,
  ): Promise<WorkspaceRecord> {
    const target = workspace.lifecycleTransitionState;

    if (target !== "paused" && target !== "deleted")
      throw new Error("Workspace has an invalid pending lifecycle transition");
    const transition = await lifecycle.lifecycleTransition(threadId, target, signal);

    if (transition.outcome === "deferred" && transition.reason === "active-run") {
      const cancelled = await store.cancelLifecycleTransition({
        threadId,
        transitionId: pendingTransitionId,
      });

      logger.info(
        { runId, threadId, target },
        "Accepted run supersedes a deferred idle lifecycle transition",
      );

      return cancelled;
    }

    if (transition.outcome === "deferred")
      throw new Error(`Workspace lifecycle is deferred by ${transition.reason}`);
    const reread = await store.readWorkspace(threadId);

    if (!reread) throw new Error("Workspace disappeared while reconciling its lifecycle");

    return reread;
  }

  /** The thread's workspace row in `provisioning`, created or recovered as needed. */
  async function provisioningWorkspace(
    runId: string,
    current: ActiveRun,
    existing: WorkspaceRecord | null,
    providerName: WorkspaceRecord["provider"],
    signal: AbortSignal,
  ): Promise<WorkspaceRecord> {
    if (!existing)
      return store.updateWorkspace({
        threadId: current.threadId,
        state: "provisioning",
        provider: providerName,
        generation: 1,
      });

    let workspace = existing;

    if (workspace.lifecycleTransitionId)
      workspace = await settlePendingTransition(
        runId,
        current.threadId,
        workspace,
        workspace.lifecycleTransitionId,
        signal,
      );

    if (workspace.state === "quarantined" || workspace.state === "recovery")
      workspace = await lifecycle.recoverQuarantinedWorkspace(current.threadId, workspace, signal);
    // Every retry reconciles unsettled operations before ensure, including
    // provisioning rows. A preparation checkpoint is informational only.
    await lifecycle.reconcileWorkspace(workspace, signal);

    if (workspace.state !== "provisioning")
      workspace = await store.updateWorkspace({
        threadId: current.threadId,
        state: "provisioning",
        provider: providerName,
        providerId: workspace.providerId,
        generation: workspace.generation,
      });

    return workspace;
  }

  /** Ensures the provider workspace exists; a replaced filesystem resets the generation. */
  async function ensureFilesystem(
    runId: string,
    current: ActiveRun,
    workspace: WorkspaceRecord,
    provider: SandboxProvider,
    wasDeleted: boolean,
    signal: AbortSignal,
  ): Promise<WorkspaceRecord> {
    const ensured = await provider.ensure(workspaceRef(workspace), signal);

    const replacement =
      ensured.disposition === "replaced" || (wasDeleted && ensured.disposition === "created");

    if (!replacement)
      return store.updateWorkspace({
        threadId: current.threadId,
        state: "provisioning",
        provider: workspace.provider,
        providerId: ensured.providerId,
        generation: workspace.generation,
      });

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
    logger.warn(
      {
        runId,
        threadId: current.threadId,
        oldGeneration: reset.oldGeneration,
        newGeneration: reset.newGeneration,
      },
      "Workspace filesystem reset; resuming from the new generation",
    );

    return reset.workspace;
  }

  /** Clones the thread's repository through the fenced command sandbox. */
  async function cloneRepository(
    runId: string,
    current: ActiveRun,
    repository: Repository,
    workspace: WorkspaceRecord,
    commandSandbox: SandboxProvider,
    ownershipToken: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (config.gitBroker && repository.repositoryUrl) {
      const preparedRef = workspaceRef(workspace);

      const git = createPiGitTools({
        client: createGitBrokerClient(
          config.gitBroker,
          { runId, generation: workspace.generation, ownershipToken },
          signal,
        ),
        exec: (request) => commandSandbox.exec(preparedRef, request, signal),
        maxBytes: config.repositoryMaxBytes,
        minFreeBytes: config.repositoryMinFreeBytes,
      });

      await git.refreshAccess(true);
    }

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
        await lifecycle.quarantineAndReplaceHeld(current.threadId, error, signal);
      throw error;
    }
  }

  async function prepareLocked(
    runId: string,
    signal: AbortSignal,
  ): Promise<PrepareWorkspaceResult> {
    const admission = await admitRun(runId);

    if (admission.kind === "stop") return admission.result;
    const { current, repository } = admission;

    const existing = await store.readWorkspace(current.threadId);
    const wasDeleted = existing?.state === "deleted";
    const providerName = existing && !wasDeleted ? existing.provider : config.sandboxProvider;

    if (config.executionMode === "pi" && providerName !== "modal")
      throw nonRetryable("REPOSITORY_PROVIDER_UNSUPPORTED");

    const provisioning = await provisioningWorkspace(
      runId,
      current,
      existing,
      providerName,
      signal,
    );

    const provider = lifecycle.sandboxFor(provisioning.provider);

    const prepared = await ensureFilesystem(
      runId,
      current,
      provisioning,
      provider,
      wasDeleted,
      signal,
    );

    const attemptId = activityAttemptId();

    const { token: ownershipToken } = await store.claimExecutionOwnership({
      runId,
      attemptId,
      generation: prepared.generation,
    });

    const commandSandbox = lifecycle.coordinatedSandbox(provider, runId, attemptId, ownershipToken);
    await cloneRepository(
      runId,
      current,
      repository,
      prepared,
      commandSandbox,
      ownershipToken,
      signal,
    );

    const running = await store.updateWorkspace({
      threadId: current.threadId,
      state: "running",
      provider: prepared.provider,
      providerId: prepared.providerId,
      generation: prepared.generation,
    });

    await store.saveCheckpoint({
      runId,
      key: "workspace-prepared",
      ownershipToken,
      generation: running.generation,
      attemptId,
      content: {
        version: 1,
        kind: "workspace-prepared",
        provider: running.provider,
        providerId: running.providerId,
        generation: running.generation,
      },
    });

    return { kind: "prepared", workspace: workspaceRef(running) };
  }

  return Effect.fnUntraced(function* (
    runId: string,
  ): Effect.fn.Return<PrepareWorkspaceResult, unknown> {
    const initial = yield* Effect.tryPromise({
      try: () => store.loadRun(runId),
      catch: (error) => error,
    });

    if (!initial) return { kind: "terminal" };

    return yield* lifecycle
      .withThreadWorkspaceLock(initial.threadId, (signal) => prepareLocked(runId, signal))
      .pipe(Effect.catch((error) => lifecycle.recoverAttempt(initial.threadId, error)));
  });
}
