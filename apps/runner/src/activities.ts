import type { Logger } from "pino";
import type { Pool } from "pg";
import type { ThreadStore } from "@cloud-swe/db/thread-contracts";
import { Context, heartbeat } from "@temporalio/activity";
import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import { setTimeout as delay } from "node:timers/promises";
import type { RunnerConfig } from "./config.js";
import { createPiExecutor, type PiSessionMetadata } from "./pi.js";
import type { SandboxProviders, WorkspaceRef } from "./sandbox.js";
import type { CheckpointRecord } from "@cloud-swe/db/thread-contracts";

function checkpointContent(checkpoint: CheckpointRecord | null): Record<string, unknown> | null {
  return checkpoint?.content && typeof checkpoint.content === "object"
    ? (checkpoint.content as Record<string, unknown>)
    : null;
}

function sessionMetadataFromCheckpoint(
  checkpoint: CheckpointRecord | null,
): PiSessionMetadata | undefined {
  const content = checkpointContent(checkpoint);
  if (
    !content ||
    content.kind !== "pi" ||
    typeof content.sessionId !== "string" ||
    typeof content.provider !== "string" ||
    typeof content.model !== "string" ||
    !Array.isArray(content.entries)
  )
    return undefined;
  return {
    sessionId: content.sessionId,
    provider: content.provider,
    model: content.model,
    entries: content.entries as PiSessionMetadata["entries"],
  };
}

export function createActivities(
  store: ThreadStore,
  sandboxes: SandboxProviders,
  logger: Logger,
  pool: Pool,
  config: RunnerConfig,
) {
  const sandboxFor = (provider: WorkspaceRef["provider"]) => {
    const sandbox = sandboxes[provider];
    if (!sandbox) throw new Error(`Sandbox provider ${provider} is not configured on this worker`);
    return sandbox;
  };

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
      // Lifecycle actions across this user's threads share one lock. A new run
      // pauses old idle computers before starting its own computer.
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
      // A disconnected database session releases its lock. Abort work and let Temporal retry.
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

  async function finalizeRun(
    runId: string,
    status: "failed" | "cancelled",
    error?: string,
  ): Promise<void> {
    const run = await store.loadRun(runId);
    if (!run) return;
    // Finalization cannot free admission while an older activity still owns this workspace.
    await withUserWorkspaceLock(run.threadId, async () => {
      if (status === "cancelled" || (await store.loadRun(runId))?.cancelRequestedAt)
        await store.cancelRun(runId);
      else await store.failRun(runId, (error ?? "Agent execution failed").slice(0, 500));
    });
  }

  return {
    finalizeRun,
    async executeRun(
      runId: string,
      options: { stepDelayMs: number; maxRunMs: number },
    ): Promise<void> {
      const initial = await store.loadRun(runId);
      if (!initial) return;
      await withUserWorkspaceLock(initial.threadId, async (signal) => {
        const current = await store.loadRun(runId);
        if (!current || !["queued", "running"].includes(current.status)) return;
        if (current.cancelRequestedAt) {
          await store.cancelRun(runId);
          return;
        }
        await store.startRun(runId);
        const started = await store.loadRun(runId);
        const startedAt = started?.startedAt?.getTime() ?? Date.now();
        const assertActive = async () => {
          signal.throwIfAborted();
          const run = await store.loadRun(runId);
          if (!run || !["queued", "running"].includes(run.status))
            throw ApplicationFailure.nonRetryable("Run is no longer active", "RUN_TERMINAL");
          if (run.cancelRequestedAt) throw new CancelledFailure("Cancellation requested");
          if (Date.now() - startedAt >= options.maxRunMs)
            throw ApplicationFailure.nonRetryable(
              "Run exceeded its active time limit",
              "RUN_TIMEOUT",
            );
        };
        if (config.executionMode === "pi") {
          const completed = checkpointContent(await store.loadCheckpoint({ runId, step: 2 }));
          if (typeof completed?.text === "string") {
            await assertActive();
            await store.completeRun(runId, completed.text);
            logger.info({ runId, threadId: current.threadId }, "Pi run finalized from checkpoint");
            return;
          }
        }
        const step = async (number: number, action: () => Promise<void>) => {
          await assertActive();
          const saved = await store.loadCheckpoint({ runId, step: number });
          if (saved) return;
          await action();
          await store.saveCheckpoint({
            runId,
            step: number,
            content: { version: 1, kind: "scripted" },
          });
          await delay(options.stepDelayMs, undefined, { signal });
        };
        const event = (type: string, payload: Record<string, unknown>, key: string) =>
          store.appendRunEvent({
            runId,
            type,
            payload: { runId, ...payload },
            dedupeKey: `run:${runId}:${key}`,
          });
        await assertActive();
        const otherWorkspaces = await pool.query<{
          thread_id: string;
          docker_name: string;
          provider: WorkspaceRef["provider"];
          provider_id: string | null;
        }>(
          `select w.thread_id, w.docker_name, w.provider, w.provider_id from workspace w join thread t on t.id = w.thread_id
           where t.user_id = $1 and w.thread_id <> $2 and w.state in ('running', 'provisioning')`,
          [current.userId, current.threadId],
        );
        for (const other of otherWorkspaces.rows) {
          const exists = await sandboxFor(other.provider).pause(
            {
              name: other.docker_name,
              provider: other.provider,
              providerId: other.provider_id,
            },
            signal,
          );
          await store.updateWorkspace({
            threadId: other.thread_id,
            state: exists ? "paused" : "deleted",
            provider: other.provider,
          });
        }
        const existingWorkspace = await store.readWorkspace(current.threadId);
        const provider =
          existingWorkspace && existingWorkspace.state !== "deleted"
            ? existingWorkspace.provider
            : config.sandboxProvider;
        if (config.executionMode === "pi" && provider !== "freestyle")
          throw new Error("Pi execution cannot reuse a Docker workspace");
        await store.updateWorkspace({
          threadId: current.threadId,
          state: "provisioning",
          provider,
        });
        const workspace = await store.readWorkspace(current.threadId);
        if (!workspace) throw new Error("Workspace record was not created");
        try {
          const workspaceRef: WorkspaceRef = {
            name: workspace.dockerName,
            provider: workspace.provider,
            providerId: workspace.providerId,
          };
          const sandbox = sandboxFor(workspaceRef.provider);
          const ensured = await sandbox.ensure(workspaceRef, signal);
          const activeWorkspace: WorkspaceRef = {
            ...workspaceRef,
            providerId: ensured.providerId,
          };
          await store.updateWorkspace({
            threadId: current.threadId,
            state: "running",
            providerId: activeWorkspace.providerId,
          });
          if (config.executionMode === "pi") {
            if (!config.aiGatewayApiKey)
              throw new Error("AI_GATEWAY_API_KEY is required for Pi execution");
            const retryCheckpoint = await store.loadCheckpoint({ runId, step: 1 });
            const piCheckpoint =
              retryCheckpoint ??
              (await store.loadLatestCheckpoint({ threadId: current.threadId, step: 1 }));
            const sessionMetadata = sessionMetadataFromCheckpoint(piCheckpoint);
            const executePi = createPiExecutor({
              sandbox,
              workspace: activeWorkspace,
              piProvider: config.piProvider,
              piModel: config.piModel,
              thinkingLevel: config.piThinkingLevel,
              aiGatewayApiKey: config.aiGatewayApiKey,
              emit: async (piEvent) => {
                await event(piEvent.type, piEvent.payload, piEvent.dedupeKey);
              },
              checkpoint: async (metadata) => {
                await store.saveCheckpoint({
                  runId,
                  step: 1,
                  content: { version: 1, kind: "pi", ...metadata },
                });
              },
            });
            const output = await executePi({
              prompt: retryCheckpoint
                ? `Continue the interrupted task from the current workspace state. Original request: ${current.prompt}`
                : current.prompt,
              runId,
              signal: AbortSignal.any([
                signal,
                AbortSignal.timeout(Math.max(1, options.maxRunMs - (Date.now() - startedAt))),
              ]),
              sessionEntries: sessionMetadata?.entries,
            });
            await store.saveCheckpoint({
              runId,
              step: 2,
              content: { version: 1, kind: "pi.completed", text: output.text },
            });
            await assertActive();
            await store.completeRun(runId, output.text);
            logger.info({ runId, threadId: current.threadId }, "Pi run completed");
          } else {
            await step(1, async () => {
              await event("assistant.started", {}, "assistant-started");
            });
            await step(2, async () => {
              await event(
                "tool.started",
                { name: "shell", command: "Write and read a scripted workspace result" },
                "tool-started",
              );
              const output = await sandbox.execStep(activeWorkspace, runId, current.prompt, signal);
              await event("tool.output", { output }, "tool-output");
              await event("tool.completed", { name: "shell", exitCode: 0 }, "tool-completed");
            });
            const chunks = [
              "The scripted workspace check ",
              "completed successfully. ",
              "The result is saved in the workspace.",
            ];
            for (const [index, content] of chunks.entries()) {
              await step(index + 3, async () => {
                await event("assistant.delta", { content }, `delta:${index}`);
              });
            }
            await assertActive();
            await store.completeRun(
              runId,
              "The scripted workspace check completed successfully. The result is saved in the workspace.",
            );
            logger.info({ runId, threadId: current.threadId }, "Scripted run completed");
          }
        } catch (error) {
          // Only the workflow finalizes exhausted retries. A transient activity failure stays resumable.
          logger.warn(
            {
              runId,
              threadId: current.threadId,
              error: error instanceof Error ? error.message : "Activity interrupted",
            },
            "Agent activity interrupted",
          );
          throw error;
        }
      });
    },
    async pauseWorkspace(threadId: string): Promise<void> {
      await withUserWorkspaceLock(threadId, async (signal) => {
        const workspace = await store.readWorkspace(threadId);
        if (!workspace || workspace.state === "deleted") return;
        const workspaceRef: WorkspaceRef = {
          name: workspace.dockerName,
          provider: workspace.provider,
          providerId: workspace.providerId,
        };
        const exists = await sandboxFor(workspaceRef.provider).pause(workspaceRef, signal);
        await store.updateWorkspace({
          threadId,
          state: exists ? "paused" : "deleted",
          provider: workspaceRef.provider,
        });
      });
    },
    async deleteWorkspace(threadId: string): Promise<void> {
      await withUserWorkspaceLock(threadId, async (signal) => {
        const workspace = await store.readWorkspace(threadId);
        if (!workspace || workspace.state === "deleted") return;
        const workspaceRef: WorkspaceRef = {
          name: workspace.dockerName,
          provider: workspace.provider,
          providerId: workspace.providerId,
        };
        await sandboxFor(workspaceRef.provider).delete(workspaceRef, signal);
        await store.updateWorkspace({
          threadId,
          state: "deleted",
          provider: workspaceRef.provider,
          providerId: null,
        });
      });
    },
  };
}
