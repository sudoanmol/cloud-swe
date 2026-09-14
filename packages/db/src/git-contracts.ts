import { createHash } from "node:crypto";
import { z } from "zod";
import { normalizeGitHubBranch, normalizeGitHubUrl } from "./repository-url";

export const gitBranchSchema = z
  .string()
  .max(255)
  .refine((v) => normalizeGitHubBranch(v) === v);

export const githubUrlSchema = z
  .string()
  .max(2048)
  .refine((v) => normalizeGitHubUrl(v) === v);

export const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);

const prNumber = z.number().int().positive();

const body = z.string().max(60_000);

const title = z.string().trim().min(1).max(256);

export const gitRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("push"),
      source: z
        .string()
        .min(1)
        .max(255)
        .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
      branch: gitBranchSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("pr_create"),
      title,
      body,
      head: gitBranchSchema,
      base: gitBranchSchema,
      draft: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pr_update"),
      number: prNumber,
      title: title.optional(),
      body: body.optional(),
    })
    .strict()
    .refine((v) => v.title !== undefined || v.body !== undefined),
  z.object({ kind: z.literal("pr_close"), number: prNumber }).strict(),
  z.object({ kind: z.literal("pr_reopen"), number: prNumber }).strict(),
  z.object({ kind: z.literal("pr_comment"), number: prNumber, body: body.min(1) }).strict(),
  z
    .object({
      kind: z.literal("pr_merge"),
      number: prNumber,
      method: z.enum(["merge", "squash", "rebase"]),
    })
    .strict(),
]);

export type GitRequest = z.infer<typeof gitRequestSchema>;

export const gitReadSchema = z
  .object({
    action: z.enum(["list", "view", "diff", "checks", "comments"]),
    number: prNumber.optional(),
    page: z.number().int().min(1).max(1000).default(1),
  })
  .strict()
  .refine((v) => v.action === "list" || v.number !== undefined);

export const gitProposalSchema = z
  .object({
    id: z.uuid(),
    toolCallId: z.string().min(1).max(255),
    repositoryUrl: githubUrlSchema,
    repositoryId: z.number().int().positive(),
    request: gitRequestSchema,
    expectedHead: gitShaSchema.nullable(),
    base: gitBranchSchema.nullable(),
    commit: gitShaSchema.nullable(),
    bundleHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    preview: z.string().max(70_000),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type GitProposal = z.infer<typeof gitProposalSchema>;

export function proposalDigest(proposal: Omit<GitProposal, "digest">): string {
  // Schema order makes the serialized request independent of incoming JSON key order.
  const parsed = gitProposalSchema.omit({ digest: true }).strip().parse(proposal);

  return createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
}

export const gitOperationSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  threadId: z.uuid(),
  userId: z.string(),
  generation: z.number().int().positive(),
  proposal: gitProposalSchema,
  approval: z.enum(["pending", "approved", "rejected", "expired", "invalidated"]),
  execution: z.enum(["not_started", "executing", "succeeded", "failed", "unknown"]),
  expiresAt: z.coerce.date(),
  createdAt: z.coerce.date(),
  decidedAt: z.coerce.date().nullable(),
  result: z.record(z.string(), z.json()).nullable(),
});

export type GitOperation = z.infer<typeof gitOperationSchema>;

export const gitContextSchema = z
  .object({ runId: z.uuid(), generation: z.number().int().positive(), ownershipToken: z.uuid() })
  .strict();

export type GitContext = z.infer<typeof gitContextSchema>;

export function gitExecutionElapsed(
  run: {
    agentStartedAt: Date | null;
    approvalWaitMs?: number;
    approvalWaitStartedAt?: Date | null;
    questionWaitMs?: number;
    questionWaitStartedAt?: Date | null;
  },
  now = Date.now(),
): number {
  if (!run.agentStartedAt) return 0;

  return Math.max(
    0,
    Math.min(
      run.approvalWaitStartedAt?.getTime() ?? now,
      run.questionWaitStartedAt?.getTime() ?? now,
    ) -
      run.agentStartedAt.getTime() -
      (run.approvalWaitMs ?? 0) -
      (run.questionWaitMs ?? 0),
  );
}
