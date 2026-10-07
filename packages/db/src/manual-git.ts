import { z } from "zod";
import { gitBranchSchema, gitShaSchema } from "./git-contracts";

export const manualGitRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("preview"),
      action: z.enum(["push", "pr_create"]),
      base: gitBranchSchema.default("main"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("push"),
      previewRunId: z.uuid(),
      commitMessage: z.string().trim().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pr_create"),
      previewRunId: z.uuid(),
      title: z.string().trim().min(1).max(256),
      body: z.string().max(60_000),
      base: gitBranchSchema,
    })
    .strict(),
]);

export type ManualGitRequest = z.infer<typeof manualGitRequestSchema>;

export const manualGitPreviewSchema = z.object({
  head: gitShaSchema,
  branch: gitBranchSchema,
  base: gitBranchSchema,
  dirty: z.boolean(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  commits: z.string().max(8000),
  stat: z.string().max(8000),
  diff: z.string().max(16_000),
  generation: z.number().int().positive(),
});

export type ManualGitPreview = z.infer<typeof manualGitPreviewSchema>;

export const manualGitTextSchema = z.object({
  commitMessage: z.string().trim().min(1).max(4000),
  title: z.string().trim().min(1).max(256),
  body: z.string().max(60_000),
});

export function manualGitFallback(input: ManualGitPreview) {
  const subject = input.commits.split("\n").find((line) => line.trim()) ?? `Update ${input.branch}`;

  return {
    commitMessage: subject.slice(0, 4000),
    title: subject.slice(0, 256),
    body: input.commits || `Changes on ${input.branch}.`,
  };
}
