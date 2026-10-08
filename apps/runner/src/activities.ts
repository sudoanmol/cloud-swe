import { createDb } from "@cloud-swe/db";
import { createAgentBrowsers } from "@cloud-swe/db/agent-browsers";
import type { AttachmentObjectStore } from "@cloud-swe/db/attachment-objects";
import { createGitStore } from "@cloud-swe/db/git-store";
import { Effect } from "effect";
import { Context } from "@temporalio/activity";
import type { Logger } from "pino";
import {
  RunnerServices,
  runActivity,
  temporalFailure,
  type ActivityRuntime,
} from "./activity-scope.js";
import type { ActivityContext } from "./activity-support.js";
import type { RunnerConfig } from "./config.js";
import { createRunExecution } from "./run-execution.js";
import type { SandboxProviders } from "./sandbox.js";
import { createWorkspaceLifecycle } from "./workspace-lifecycle.js";
import { createPrepareWorkspace } from "./workspace-preparation.js";

export function createActivities(
  runtime: ActivityRuntime,
  sandboxes: SandboxProviders,
  logger: Logger,
  config: RunnerConfig,
  attachmentObjects?: AttachmentObjectStore,
) {
  const { store, pool, coordinator } = runtime.runSync(RunnerServices);
  const gitStore = createGitStore(createDb(pool));

  const ctx: ActivityContext = {
    store,
    pool,
    coordinator,
    gitStore,
    logger,
    config,
    sandboxes,
    attachmentObjects,
  };

  const lifecycle = createWorkspaceLifecycle(ctx);
  const prepareWorkspace = createPrepareWorkspace(ctx, lifecycle);
  const execution = createRunExecution(ctx, lifecycle);

  const agentBrowsers =
    config.browser &&
    createAgentBrowsers({
      apiKey: config.browser.kernelApiKey,
      idleSeconds: config.browser.idleSeconds,
    });

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
    approvalStatus: async (runId: string) => {
      await gitStore.expire(runId);
      const pending = (await gitStore.forRun(runId)).find((op) => op.approval === "pending");

      return pending
        ? { pending: true, expiresAt: pending.expiresAt.getTime() }
        : { pending: false, expiresAt: 0 };
    },
    resumeApproval: (runId: string) => gitStore.resume(runId),
    questionStatus: async (runId: string) => ({
      pending: Boolean(await store.pendingQuestionRequest(runId)),
    }),
    resumeQuestions: (runId: string) => store.resumeQuestionWait(runId),
    pauseForApproval: adapter((runId: string) =>
      lifecycle.pauseForPerson(runId, "approvalWaitStartedAt"),
    ),
    pauseForQuestions: adapter((runId: string) =>
      lifecycle.pauseForPerson(runId, "questionWaitStartedAt"),
    ),
    runPi: adapter(execution.runPi),
    runScripted: adapter(execution.runScripted),
    runExecution: adapter(execution.runExecution),
    finalizeRun: adapter((...args: Parameters<typeof execution.finalizeRun>) =>
      Effect.tryPromise({ try: () => execution.finalizeRun(...args), catch: (error) => error }),
    ),
    pauseWorkspace: adapter((threadId: string) => {
      return lifecycle.withThreadWorkspaceLock(threadId, (signal) =>
        lifecycle.lifecycleTransition(threadId, "paused", signal),
      );
    }),
    deleteThread: adapter((threadId: string) =>
      lifecycle.withThreadWorkspaceLock(threadId, async (signal): Promise<void> => {
        const result = await lifecycle.lifecycleTransition(threadId, "deleted", signal);

        if (result.outcome === "deferred")
          throw new Error(`Thread deletion deferred: ${result.reason}`);
        // The saved profile holds the user's logins; it goes with the thread.
        await agentBrowsers?.forget(threadId);
        await store.purgeThread(threadId);
      }),
    ),
    wakeWorkspace: adapter(lifecycle.wakeWorkspace),
    idleDeferralMs: adapter((threadId: string, idlePauseMs: number) =>
      Effect.tryPromise({
        try: () => lifecycle.reviewDeferralMs(threadId, idlePauseMs),
        catch: (error) => error,
      }),
    ),
  };
}
