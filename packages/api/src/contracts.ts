import { z } from "zod";

import { modelCatalogEntrySchema, modelSelectionSchema } from "@cloud-swe/db/model-contracts";
import { questionSchema } from "@cloud-swe/db/question-contracts";
import { workspaceDiffStatSchema } from "@cloud-swe/db/workspace-review";

/**
 * Browser-safe wire contracts for the cloud-swe REST and SSE API.
 *
 * These schemas describe exactly what the API returns to a browser: public
 * projection fields only. They must not be replaced by persistence records or
 * by spreading database rows. Server-side validation stays at each route
 * entry boundary and reuses the corresponding structural schemas.
 */

export const isoDateTimeSchema = z.iso.datetime();

export const errorPayloadSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }),
});

export const runStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled"]);

export type RunStatus = z.infer<typeof runStatusSchema>;

export const workspaceStateSchema = z.enum([
  "provisioning",
  "running",
  "paused",
  "deleted",
  "failed",
  "quarantined",
  "recovery",
]);

export const publicAttachmentMetadataSchema = z.object({
  id: z.uuid(),
  filename: z.string(),
  detectedMimeType: z.string(),
  classification: z.enum(["image", "file"]),
  size: z.number().int().nonnegative().nullable(),
  modelMimeType: z.string().nullable(),
  modelSize: z.number().int().nonnegative().nullable(),
  modelWidth: z.number().int().positive().nullable(),
  modelHeight: z.number().int().positive().nullable(),
});

export type PublicAttachmentMetadata = z.infer<typeof publicAttachmentMetadataSchema>;

export const threadMessageSchema = z.object({
  id: z.uuid(),
  runId: z.uuid().nullable(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  clientMessageId: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  attachments: z.array(publicAttachmentMetadataSchema),
});

export const threadRunSchema = z.object({
  id: z.uuid(),
  status: runStatusSchema,
  prompt: z.string(),
  modelSelection: modelSelectionSchema.nullable(),
  cancelRequestedAt: isoDateTimeSchema.nullable(),
  approvalWaitStartedAt: isoDateTimeSchema.nullable(),
  questionWaitStartedAt: isoDateTimeSchema.nullable(),
  startedAt: isoDateTimeSchema.nullable(),
  completedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  error: z.string().nullable(),
});

export const threadWorkspaceSchema = z.object({
  id: z.uuid(),
  state: workspaceStateSchema,
  provider: z.enum(["docker", "modal"]),
  generation: z.number().int().positive(),
  updatedAt: isoDateTimeSchema,
});

export const threadSnapshotSchema = z.object({
  id: z.uuid(),
  userId: z.string().min(1),
  title: z.string().nullable(),
  repositoryUrl: z.string().nullable(),
  repositoryBranch: z.string().nullable(),
  messages: z.array(threadMessageSchema),
  runs: z.array(threadRunSchema),
  workspace: threadWorkspaceSchema.nullable(),
  latestEventId: z.number().int().nonnegative().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type ThreadSnapshot = z.infer<typeof threadSnapshotSchema>;

export const threadSummarySchema = z.object({
  id: z.uuid(),
  title: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  runStatus: runStatusSchema.nullable(),
  workspaceState: workspaceStateSchema.nullable(),
  repositoryUrl: z.string().nullable(),
  repositoryBranch: z.string().nullable(),
  diffStat: workspaceDiffStatSchema.nullable(),
});

export type ThreadSummary = z.infer<typeof threadSummarySchema>;

export const threadListResponseSchema = z.object({
  threads: z.array(threadSummarySchema),
  nextCursor: z.string().nullable(),
});

export const submitResultSchema = z.object({
  threadId: z.uuid(),
  runId: z.uuid(),
});

export type SubmitResult = z.infer<typeof submitResultSchema>;

export const cancelResultSchema = z.object({
  runId: z.uuid(),
  cancelRequested: z.literal(true),
});

export type CancelResult = z.infer<typeof cancelResultSchema>;

export const questionRequestSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  threadId: z.uuid(),
  toolCallId: z.string().min(1),
  questions: z.array(questionSchema).min(1).max(3),
  state: z.enum(["pending", "answered", "cancelled"]),
  answers: z.record(z.string(), z.string()).nullable(),
  createdAt: isoDateTimeSchema,
  answeredAt: isoDateTimeSchema.nullable(),
  cancelledAt: isoDateTimeSchema.nullable(),
});

export type QuestionRequest = z.infer<typeof questionRequestSchema>;

export const questionsResponseSchema = z.object({ requests: z.array(questionRequestSchema) });

export const modelProviderSummarySchema = z.object({
  id: z.enum(["vercel-ai-gateway", "openrouter", "deepseek", "openai-codex"]),
  name: z.string(),
  authType: z.enum(["api_key", "oauth"]),
  connected: z.boolean(),
});

export const modelProvidersResponseSchema = z.object({
  providers: z.array(modelProviderSummarySchema),
});

export const modelCatalogResponseSchema = z.object({
  source: z.literal("pi-ai"),
  version: z.string(),
  models: z.array(modelCatalogEntrySchema),
});

export type ModelCatalogResponse = z.infer<typeof modelCatalogResponseSchema>;

export const attachmentUploadResponseSchema = z.object({
  id: z.uuid(),
  filename: z.string(),
  detectedMimeType: z.string(),
  classification: z.enum(["image", "file"]),
  size: z.number().int().nonnegative().nullable(),
  modelMimeType: z.string().nullable(),
  modelSize: z.number().int().nonnegative().nullable(),
  modelWidth: z.number().int().positive().nullable(),
  modelHeight: z.number().int().positive().nullable(),
});

export type AttachmentUploadResponse = z.infer<typeof attachmentUploadResponseSchema>;

export const githubInstallationSchema = z.object({
  id: z.number().int().positive(),
  accountLogin: z.string(),
  accountType: z.string(),
  targetType: z.string(),
  appId: z.number().int().positive(),
  appSlug: z.string(),
  suspended: z.boolean(),
  repositorySelection: z.string(),
});

export type GithubInstallation = z.infer<typeof githubInstallationSchema>;

export const githubInstallationsResponseSchema = z.object({
  items: z.array(githubInstallationSchema),
  nextPage: z.number().int().positive().nullable(),
});

export const githubRepositorySchema = z.object({
  id: z.number().int().positive().optional(),
  fullName: z.string(),
  owner: z.string(),
  name: z.string(),
  private: z.boolean(),
  defaultBranch: z.string().nullable(),
  /** `true` for an unborn repository, `null` when the provider omitted size. */
  empty: z.boolean().nullable().optional(),
});

export type GithubRepository = z.infer<typeof githubRepositorySchema>;

export const githubRepositoriesResponseSchema = z.object({
  items: z.array(githubRepositorySchema),
  nextPage: z.number().int().positive().nullable(),
});

export const githubBranchSchema = z.object({
  name: z.string(),
  sha: z.string().optional(),
});

export type GithubBranch = z.infer<typeof githubBranchSchema>;

export const githubBranchesResponseSchema = z.object({
  items: z.array(githubBranchSchema),
  nextPage: z.number().int().positive().nullable(),
});

export const onboardingResponseSchema = z.object({
  completed: z.boolean(),
  github: z.object({
    ready: z.boolean(),
    installUrl: z.string().nullable(),
    /** Retryable GitHub/config failure; never proof that installations disappeared. */
    transientError: z.boolean(),
    hasAnyInstallation: z.boolean(),
  }),
  providerReady: z.boolean(),
});

export type OnboardingResponse = z.infer<typeof onboardingResponseSchema>;

export const onboardingCompleteResponseSchema = z.object({
  completed: z.literal(true),
});

/**
 * ChatGPT device login. The first response carries the user code the browser
 * shows; later polls report only a terminal state.
 */
export const deviceLoginStatusSchema = z.discriminatedUnion("status", [
  z.object({
    id: z.uuid(),
    status: z.literal("pending"),
    userCode: z.string().min(1),
    verificationUri: z.string().min(1),
    intervalSeconds: z.number().int().positive(),
    expiresAt: isoDateTimeSchema,
  }),
  z.object({
    id: z.uuid(),
    status: z.enum(["starting", "authorized", "failed", "expired"]),
  }),
]);

export type DeviceLoginStatus = z.infer<typeof deviceLoginStatusSchema>;
