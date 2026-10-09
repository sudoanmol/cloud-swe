import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  gitPrImpactSchema,
  gitPushImpactSchema,
  type GitOperation,
} from "@cloud-swe/db/git-contracts";
import {
  manualGitCheckSchema,
  manualGitLocalSchema,
  manualGitRequestSchema,
  type ManualGitCheck,
} from "@cloud-swe/db/manual-git";
import { publicFailure } from "@cloud-swe/db/public-failure";
import {
  ThreadStoreError,
  type ThreadStore,
  type RunRecord,
  type WorkspaceRef,
} from "@cloud-swe/db/thread-contracts";
import type { GitStore } from "@cloud-swe/db/git-store";
import { gitShaSchema } from "@cloud-swe/db/git-contracts";
import { quoteShell } from "./text.js";
import { createGitBrokerClient, createPiGitTools, gitConfigPath } from "./git-tools.js";
import type { CommandRequest, CommandResult } from "./sandbox.js";
import type { RunnerConfig } from "./config.js";

const program = readFileSync(new URL("./guest/manual-git.py", import.meta.url), "utf8");

/** A user-facing refusal: the run fails with this message instead of retrying. */
class ManualGitStop extends Error {}

/**
 * User-initiated Git runs. A `check` run snapshots the checkout and asks the
 * broker what a push or PR would do. A `push` or `pr` run repeats the work the
 * user confirmed: commit, push and open the PR. The confirmation is the
 * approval, so proposals publish as approved and execute immediately through
 * the normal dispatch claim and reconciliation path.
 */
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
  const request = manualGitRequestSchema.parse(run.manualGit);
  const ownership = { runId: run.id, generation: workspace.generation, attemptId, ownershipToken };
  const broker = input.config.gitBroker;

  if (!broker) throw new ThreadStoreError("GIT_ACCESS_DENIED", "Git broker is unavailable", 409);

  const client = createGitBrokerClient(
    broker,
    { runId: run.id, generation: workspace.generation, ownershipToken },
    input.signal,
  );

  const git = createPiGitTools({
    client,
    exec: input.exec,
    maxBytes: input.config.repositoryMaxBytes,
    minFreeBytes: input.config.repositoryMinFreeBytes,
  });

  async function guest(data: Record<string, string>) {
    // The access config carries the user's commit identity.
    await git.refreshAccess();

    const result = await input.exec({
      command: `cd /workspace && GIT_CONFIG_GLOBAL=${gitConfigPath} python3 -c ${quoteShell(program)}`,
      stdin: JSON.stringify({ ...data, runId: run.id }),
      timeoutMs: 120_000,
    });

    // An interrupted command retries; the guest program is idempotent per run.
    if (result.kind !== "completed" || result.outputTruncated)
      throw new Error("Manual Git command did not complete");

    if (result.statusCode !== 0)
      throw new ManualGitStop(
        /changed since the check/.test(result.stderr)
          ? "The workspace changed after the check. Check again."
          : "Git could not read the workspace. The branch may be detached or mid-merge.",
      );

    return result.stdout.trim();
  }

  /** Publishes the confirmed proposal as approved and executes it. */
  async function write(
    kind: GitOperation["proposal"]["request"]["kind"],
    propose: () => Promise<void>,
  ) {
    const prior = (await input.gitStore.forRun(run.id)).find(
      (op) => op.proposal.request.kind === kind,
    );

    if (prior) return git.receipt(prior.id);
    await propose();
    const proposal = git.pending();

    if (!proposal) throw new Error("Manual Git proposal is missing");
    await store.saveCheckpoint({
      ...ownership,
      key: "manual-git-proposal",
      content: { operationId: proposal.id },
      gitProposal: proposal,
    });

    return git.receipt(proposal.id);
  }

  try {
    if (request.kind === "check") {
      const local = manualGitLocalSchema.parse(
        JSON.parse(
          await guest({
            kind: "check",
            base: (await store.readRepositoryBranch(run.threadId)) ?? "",
          }),
        ),
      );

      const bundle = await git.exportBundle(local.commit);

      const remote = z
        .object({
          defaultBranch: z.string(),
          expectedHead: gitShaSchema.nullable(),
          push: gitPushImpactSchema,
          pr: gitPrImpactSchema.nullable(),
        })
        .parse(
          await client.call("check", {
            push: bundle,
            branch: local.branch,
            action: request.action,
          }),
        );

      await store.saveCheckpoint({
        ...ownership,
        key: "manual-git-check",
        content: manualGitCheckSchema.parse({
          action: request.action,
          generation: workspace.generation,
          local,
          ...remote,
        }),
      });
      await store.completeRun(run.id, "", ownershipToken);

      return;
    }

    const saved = await store.loadCheckpoint({
      runId: request.checkRunId,
      key: "manual-git-check",
    });

    const check: ManualGitCheck = manualGitCheckSchema.parse(saved?.content);

    if (check.generation !== workspace.generation)
      throw new ManualGitStop("The workspace was replaced after the check. Check again.");

    if (check.push.nonFastForward && check.push.branch === check.defaultBranch)
      throw new ManualGitStop(
        `Force pushing to the default branch ${check.defaultBranch} is not allowed.`,
      );

    const commit = check.local.dirty
      ? gitShaSchema.parse(
          await guest({
            kind: "commit",
            fingerprint: check.local.fingerprint,
            message: request.commitMessage,
          }),
        )
      : check.local.head;

    const needsPush =
      check.local.dirty ||
      check.push.newBranch ||
      check.push.commits > 0 ||
      check.push.nonFastForward;

    if (needsPush) {
      const pushed = await write("push", async () => {
        await git.propose(
          {
            kind: "push",
            source: commit,
            branch: check.local.branch,
            ...(check.push.nonFastForward && { force: true }),
          },
          `manual:${run.id}:push`,
        );

        if (git.pending()?.expectedHead !== check.expectedHead)
          throw new ManualGitStop("The remote branch changed after the check. Check again.");
      });

      if (pushed.execution !== "succeeded") throw new ManualGitStop(outcome("Push", pushed));
    }

    let pullRequest: { number: number; url: string } | null = null;

    if (request.kind === "pr") {
      if (!check.pr)
        throw new ManualGitStop("This branch has no base branch to open a PR against.");

      if (check.pr.conflicts.length)
        throw new ManualGitStop("The branch conflicts with its base. Resolve the conflicts first.");
      const base = check.pr.base;

      const opened = await write("pr_create", async () => {
        await git.propose(
          {
            kind: "pr_create",
            title: request.title,
            body: request.body,
            head: check.local.branch,
            base,
            draft: false,
          },
          `manual:${run.id}:pr`,
        );
      });

      if (opened.execution !== "succeeded")
        throw new ManualGitStop(outcome("Pull request", opened));
      const url = z.url().parse(opened.result?.url);
      const number = Number(new URL(url).pathname.match(/\/pull\/(\d+)$/)?.[1]);
      pullRequest = { number, url };
    }

    await store.saveCheckpoint({
      ...ownership,
      key: "manual-git-result",
      content: { commit, branch: check.local.branch, pullRequest },
    });
    await store.completeRun(run.id, "", ownershipToken);
  } catch (error) {
    if (error instanceof ManualGitStop) {
      await store.failRun(run.id, error.message, "MANUAL_GIT_STOPPED");

      return;
    }

    const failure = publicFailure(error);

    // Broker refusals are final for this confirmation; transport failures retry.
    if (failure.code.startsWith("GIT_") && failure.statusCode < 500) {
      await store.failRun(run.id, failure.message, failure.code);

      return;
    }

    throw error;
  }
}

function outcome(label: string, op: GitOperation) {
  return op.execution === "unknown"
    ? `${label} outcome is unknown. Do not retry; it will be reconciled.`
    : `${label} failed${op.result && "code" in op.result ? `: ${String(op.result.code)}` : ""}.`;
}
