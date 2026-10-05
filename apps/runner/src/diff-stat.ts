import { publicFailureMessage } from "@cloud-swe/db/public-failure";
import { workspaceReviewProgram } from "@cloud-swe/db/workspace-review-program";
import {
  reviewEnvelopeSchema,
  workspaceDiffStatSchema,
  type WorkspaceDiffStat,
} from "@cloud-swe/db/workspace-review";
import type { Logger } from "pino";
import type { SandboxProvider, WorkspaceRef } from "./sandbox.js";
import { quoteShell } from "./text.js";

const statTimeoutMs = 20_000;

const statEnvelopeSchema = reviewEnvelopeSchema(workspaceDiffStatSchema.nullable());

/**
 * Counts changes against the branch tip with a read-only guest command. Like
 * the bash journal observer, it is a provider read, not a coordinated
 * workspace mutation: it never takes the guest workspace lock.
 */
export async function readDiffStat(
  provider: Pick<SandboxProvider, "exec">,
  workspace: WorkspaceRef,
  branch: string | null,
  signal: AbortSignal,
): Promise<WorkspaceDiffStat | null> {
  const result = await provider.exec(
    workspace,
    {
      command: `python3 -c ${quoteShell(workspaceReviewProgram)} stat ${quoteShell(branch ?? "")}`,
      timeoutMs: statTimeoutMs,
    },
    signal,
  );

  if (result.kind !== "completed" || result.statusCode !== 0) return null;

  const parsed = statEnvelopeSchema.safeParse(JSON.parse(result.stdout));

  return parsed.success && parsed.data.ok ? parsed.data.result : null;
}

/**
 * Coalesces refreshes requested by tool completions: at most one count runs and
 * one more waits. Counts are best-effort; the store skips unchanged values.
 */
export function createDiffStatRefresher(input: {
  read: () => Promise<WorkspaceDiffStat | null>;
  publish: (stat: WorkspaceDiffStat) => Promise<void>;
  logger: Pick<Logger, "warn">;
}) {
  let chain: Promise<void> = Promise.resolve();
  let queued = false;

  return {
    refresh() {
      if (queued) return;
      queued = true;
      chain = chain.then(async () => {
        queued = false;

        try {
          const stat = await input.read();

          if (stat) await input.publish(stat);
        } catch (error) {
          input.logger.warn({ err: publicFailureMessage(error) }, "Diff count refresh failed");
        }
      });
    },
    /** Waits for every requested refresh. */
    settled: () => chain,
  };
}
