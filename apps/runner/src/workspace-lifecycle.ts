import { Effect } from "effect";
import { Context } from "@temporalio/activity";
import {
  WORKSPACE_RESET_INSTRUCTION,
  type CleanupProviderResult,
  type CleanupResult,
  type WorkspaceRecord,
  type WorkspaceRef,
} from "@cloud-swe/db/thread-contracts";
import { publicFailureMessage } from "@cloud-swe/db/public-failure";
import { workspaceLock } from "./activity-scope.js";
import {
  nonRetryable,
  rethrowAsReprepareIfGenerationMismatch,
  workspaceRef,
  type ActivityContext,
  type LifecycleResult,
} from "./activity-support.js";
import { readDiffStat } from "./diff-stat.js";
import { UnresolvedCommandError } from "./execution-coordinator.js";
import { processResult, type CommandRequest, type SandboxProvider } from "./sandbox.js";

/** Time a pause needs before the hard timeout: reconciliation plus the exit snapshot. */
const lifecyclePauseMarginMs = 120_000;

function mapCleanupResult(result: CleanupResult): LifecycleResult {
  if (result.outcome === "deferred") return { outcome: "deferred", reason: result.reason };

  if (result.outcome === "unknown")
    throw new Error("Provider outcome is unknown; workspace remains protected");

  return { outcome: result.outcome };
}

/**
 * Workspace access and lifecycle for the activities: coordinated sandbox
 * commands, the per-thread lock, pause/delete transitions, wake, and recovery
 * after an unknown command outcome.
 */
export function createWorkspaceLifecycle(ctx: ActivityContext) {
  const { store, pool, coordinator, logger, config, sandboxes } = ctx;

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

    let providerId = resolved.workspace.providerId;

    if (workspace.provider === "modal") {
      const ensured = await provider.ensure(resolved.workspace, signal);

      if (ensured.disposition === "replaced") throw nonRetryable("WORKSPACE_REPREPARE");
      // A restore continues the filesystem in a new sandbox.
      providerId = ensured.providerId;
    }

    if (providerId && providerId !== workspace.providerId) {
      return store.persistRecoveredProviderId({ workspaceId: workspace.id, providerId });
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
    waitingRunId?: string,
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
      waitingRunId,
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

  /**
   * Milliseconds to keep the workspace awake for recent review, preview, or
   * browser-panel use, never past the provider's hard timeout.
   */
  async function reviewDeferralMs(threadId: string, idlePauseMs: number): Promise<number> {
    const remaining = await store.reviewIdleRemainingMs(threadId, idlePauseMs);
    const workspace = remaining > 0 ? await store.readWorkspace(threadId) : null;

    if (!workspace?.providerId) return 0;

    const { expiresAt } = await sandboxFor(workspace.provider).resolve(
      workspaceRef(workspace),
      Context.current().cancellationSignal,
    );

    // Pause before the provider's hard timeout stops the sandbox under a reader.
    const beforeTimeout =
      expiresAt === undefined ? remaining : expiresAt - Date.now() - lifecyclePauseMarginMs;

    return Math.max(0, Math.min(remaining, beforeTimeout));
  }

  /**
   * Pauses a run's workspace while it waits for a person, unless they are
   * using it: signing in through the browser during a handoff keeps it awake.
   */
  function pauseForPerson(
    runId: string,
    wait: "approvalWaitStartedAt" | "questionWaitStartedAt",
  ): Effect.Effect<LifecycleResult | undefined, unknown> {
    return Effect.gen(function* () {
      const current = yield* Effect.tryPromise({
        try: () => store.loadRun(runId),
        catch: (error) => error,
      });

      if (!current?.[wait]) return;

      const deferral = yield* Effect.tryPromise({
        try: () => reviewDeferralMs(current.threadId, config.idlePauseMs),
        catch: (error) => error,
      });

      if (deferral > 0)
        return {
          outcome: "deferred",
          reason: "in-use",
          retryAfterMs: deferral,
        } satisfies LifecycleResult;

      return yield* withThreadWorkspaceLock(current.threadId, (signal) =>
        lifecycleTransition(current.threadId, "paused", signal, runId),
      );
    });
  }

  /** Wakes an idle-paused workspace so the review panel can read it. */
  function wakeWorkspace(threadId: string) {
    return withThreadWorkspaceLock(threadId, async (signal): Promise<void> => {
      const workspace = await store.readWorkspace(threadId);

      // Only an idle-paused workspace wakes; runs own every other transition.
      if (!workspace || workspace.state !== "paused" || workspace.lifecycleTransitionId) return;
      const provider = sandboxFor(workspace.provider);
      await reconcileWorkspace(workspace, signal);
      const ensured = await provider.ensure(workspaceRef(workspace), signal);

      if (ensured.disposition === "replaced") {
        // The snapshot is gone. Record the reset; the next run re-clones.
        await store.resetWorkspace({
          threadId,
          expectedGeneration: workspace.generation,
          transitionId: `reset:${workspace.id}:${workspace.generation}:${ensured.providerId}`,
          reason: WORKSPACE_RESET_INSTRUCTION,
          providerId: ensured.providerId,
          confirmedMissing: true,
          state: "provisioning",
        });

        return;
      }

      await store.updateWorkspace({
        threadId,
        state: "running",
        provider: workspace.provider,
        providerId: ensured.providerId,
        generation: workspace.generation,
      });

      // Recount on wake so the pill reflects the restored files.
      try {
        const stat = await readDiffStat(
          provider,
          workspaceRef({ ...workspace, providerId: ensured.providerId }),
          await store.readRepositoryBranch(threadId),
          signal,
        );

        if (stat) await store.recordDiffStat({ threadId, generation: workspace.generation, stat });
      } catch (error) {
        logger.warn({ err: publicFailureMessage(error) }, "Diff count refresh failed");
      }
    });
  }

  return {
    sandboxFor,
    coordinatedSandbox,
    withThreadWorkspaceLock,
    recoverAttempt,
    resolveExecutionWorkspace,
    reconcileWorkspace,
    lifecycleTransition,
    quarantineAndReplaceHeld,
    recoverQuarantinedWorkspace,
    reviewDeferralMs,
    pauseForPerson,
    wakeWorkspace,
  };
}

export type WorkspaceLifecycle = ReturnType<typeof createWorkspaceLifecycle>;
