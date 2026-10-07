import { readFileSync } from "node:fs";
import { z } from "zod";
import { manualGitPreviewSchema, manualGitRequestSchema } from "@cloud-swe/db/manual-git";
import {
  ThreadStoreError,
  type ThreadStore,
  type RunRecord,
  type WorkspaceRef,
} from "@cloud-swe/db/thread-contracts";
import type { GitStore } from "@cloud-swe/db/git-store";
import { quoteShell } from "./text.js";
import { createGitBrokerClient, createPiGitTools } from "./git-tools.js";
import type { CommandRequest, CommandResult } from "./sandbox.js";
import type { RunnerConfig } from "./config.js";

const program = readFileSync(new URL("./guest/manual-git.py", import.meta.url), "utf8");

export async function executeManualGit(input: {
  store: ThreadStore;
  gitStore: GitStore;
  run: RunRecord;
  workspace: WorkspaceRef;
  attemptId: string;
  ownershipToken: string;
  config: Pick<RunnerConfig, "gitBroker" | "repositoryMaxBytes" | "repositoryMinFreeBytes">;
  signal: AbortSignal;
  exec: (request: CommandRequest) => Promise<CommandResult>;
}) {
  const { store, run, workspace, ownershipToken, attemptId } = input;
  const saved = await store.loadCheckpoint({ runId: run.id, key: "manual-git-request" });
  const request = manualGitRequestSchema.parse(saved?.content);
  const ownership = { runId: run.id, generation: workspace.generation, attemptId, ownershipToken };
  const broker = input.config.gitBroker;

  if (!broker) throw new ThreadStoreError("GIT_ACCESS_DENIED", "Git broker is unavailable", 409);

  const git = createPiGitTools({
    client: createGitBrokerClient(
      broker,
      { runId: run.id, generation: workspace.generation, ownershipToken },
      input.signal,
    ),
    exec: input.exec,
    maxBytes: input.config.repositoryMaxBytes,
    minFreeBytes: input.config.repositoryMinFreeBytes,
  });

  const operations = await input.gitStore.forRun(run.id);
  const operation = operations.at(-1);

  if (operation) {
    if (operation.approval === "pending")
      return {
        kind: "awaiting_approval" as const,
        operationId: operation.id,
        expiresAt: operation.expiresAt.getTime(),
      };
    const result = await git.receipt(operation.id);
    await store.completeRun(
      run.id,
      `Manual Git operation: ${result.execution === "not_started" ? result.approval : result.execution}.`,
      ownershipToken,
    );

    return;
  }

  async function guest(data: Record<string, string | number>) {
    const result = await input.exec({
      command: `cd /workspace && python3 -c ${quoteShell(program)}`,
      stdin: JSON.stringify({ ...data, runId: run.id, generation: workspace.generation }),
      timeoutMs: 120_000,
    });

    if (result.kind !== "completed" || result.statusCode !== 0 || result.outputTruncated)
      throw new ThreadStoreError("GIT_PROPOSAL_STALE", "Manual Git preparation failed", 409);

    return result.stdout.trim();
  }

  if (request.kind === "preview") {
    const cached = await store.loadCheckpoint({
      runId: run.id,
      key: "manual-git-preview",
      generation: workspace.generation,
    });

    const preview = manualGitPreviewSchema.parse(
      cached?.content ?? JSON.parse(await guest({ kind: "preview", base: request.base })),
    );

    await store.saveCheckpoint({ ...ownership, key: "manual-git-preview", content: preview });
    await store.completeRun(run.id, "Git changes are ready to review.", ownershipToken);

    return;
  }

  const previewRun = await store.loadRun(request.previewRunId);

  if (previewRun?.threadId !== run.threadId || previewRun.userId !== run.userId)
    throw new ThreadStoreError("GIT_ACCESS_DENIED", "Preview is not owned", 403);

  const preview = manualGitPreviewSchema.parse(
    (
      await store.loadCheckpoint({
        runId: request.previewRunId,
        key: "manual-git-preview",
        generation: workspace.generation,
      })
    )?.content,
  );

  if (preview.generation !== workspace.generation)
    throw new ThreadStoreError("GIT_PROPOSAL_STALE", "Workspace was replaced", 409);
  let source = preview.head;

  if (request.kind === "push")
    source = z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .parse(
        await guest({
          kind: "commit",
          fingerprint: preview.fingerprint,
          message: request.commitMessage,
        }),
      );
  await git.propose(
    request.kind === "push"
      ? { kind: "push", source, branch: preview.branch }
      : {
          kind: "pr_create",
          title: request.title,
          body: request.body,
          head: preview.branch,
          base: request.base,
          draft: false,
        },
    `manual:${run.id}`,
  );
  const proposal = git.pending();

  if (!proposal) throw new Error("Manual Git proposal is missing");
  await store.saveCheckpoint({
    ...ownership,
    key: "manual-git-proposal",
    content: { operationId: proposal.id },
    gitProposal: proposal,
  });

  return {
    kind: "awaiting_approval" as const,
    operationId: proposal.id,
    expiresAt: Date.now() + 86_400_000,
  };
}
