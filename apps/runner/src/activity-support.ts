import { createDb } from "@cloud-swe/db";
import type { AttachmentObjectStore } from "@cloud-swe/db/attachment-objects";
import type { createGitStore } from "@cloud-swe/db/git-store";
import { createModelCredentialStore } from "@cloud-swe/db/model-credentials";
import { modelSelectionSchema } from "@cloud-swe/db/model-selection";
import { publicFailureForCode } from "@cloud-swe/db/public-failure";
import type {
  RunRecord,
  ThreadStore,
  WorkspaceRecord,
  WorkspaceRef,
} from "@cloud-swe/db/thread-contracts";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import type { Pool } from "pg";
import type { Logger } from "pino";
import type { RunnerConfig } from "./config.js";
import type { ExecutionCoordinator } from "./execution-coordinator.js";
import { failureIdentities } from "./failure.js";
import type { SandboxProviders } from "./sandbox.js";

export type RunExecutionResult =
  | {
      kind: "awaiting_approval";
      operationId: string;
      expiresAt: number;
    }
  | {
      kind: "awaiting_questions";
      requestId: string;
    }
  | void;

export type PrepareWorkspaceResult =
  | { kind: "prepared"; workspace: WorkspaceRef }
  | { kind: "cancelled" | "terminal" };

export type LifecycleResult =
  | { outcome: "completed" | "missing" }
  | { outcome: "deferred"; reason: "active-run" | "unsettled-command" }
  | { outcome: "deferred"; reason: "in-use"; retryAfterMs: number };

/** What every activity needs: durable state, the command coordinator, and worker configuration. */
export type ActivityContext = {
  store: ThreadStore;
  pool: Pool;
  coordinator: ExecutionCoordinator;
  gitStore: ReturnType<typeof createGitStore>;
  logger: Logger;
  config: RunnerConfig;
  sandboxes: SandboxProviders;
  attachmentObjects: AttachmentObjectStore | undefined;
};

export type ActiveRun = RunRecord & { status: "queued" | "running" };

export function nonRetryable(type: string): ApplicationFailure {
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
export function rethrowAsReprepareIfGenerationMismatch(error: unknown): never {
  if (isWorkspaceGenerationMismatch(error)) throw nonRetryable("WORKSPACE_REPREPARE");
  throw error;
}

export function runIsActive(run: RunRecord | null): run is ActiveRun {
  return run !== null && (run.status === "queued" || run.status === "running");
}

export function activityAttemptId(): string {
  const info = Context.current().info;

  return `${info.activityId}:${info.attempt}`;
}

export function workspaceRef(workspace: WorkspaceRecord): WorkspaceRef {
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
 * The persisted model selection and its stored credential. Submission checks
 * both too, but credentials can disappear before the run starts or resumes.
 */
export async function requireModelCredentials(
  ctx: ActivityContext,
  run: Pick<RunRecord, "modelSelection" | "userId">,
) {
  const selection = modelSelectionSchema.safeParse(run.modelSelection);

  if (!selection.success) throw nonRetryable("MODEL_SELECTION_REQUIRED");

  if (!ctx.config.modelCredentialsEncryptionKey) throw nonRetryable("INVALID_CONFIGURATION");

  const credentials = createModelCredentialStore(
    createDb(ctx.pool),
    run.userId,
    ctx.config.modelCredentialsEncryptionKey,
  );

  if (!(await credentials.read(selection.data.provider)))
    throw nonRetryable("MODEL_CREDENTIAL_REQUIRED");

  return { selection: selection.data, credentials };
}
