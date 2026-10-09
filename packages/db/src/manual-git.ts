import { z } from "zod";
import {
  gitBranchSchema,
  gitPrImpactSchema,
  gitPushImpactSchema,
  gitShaSchema,
} from "./git-contracts";

const commitMessage = z.string().trim().min(1).max(4000);

/** Stored on `run.manual_git`. Texts are final: the API fills blank fields before submitting. */
export const manualGitRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("check"), action: z.enum(["push", "pr"]) }).strict(),
  z.object({ kind: z.literal("push"), checkRunId: z.uuid(), commitMessage }).strict(),
  z
    .object({
      kind: z.literal("pr"),
      checkRunId: z.uuid(),
      commitMessage,
      title: z.string().trim().min(1).max(256),
      body: z.string().max(60_000),
    })
    .strict(),
]);

export type ManualGitRequest = z.infer<typeof manualGitRequestSchema>;

/** What the guest reports about the checkout. `commit` is a ref-less snapshot when dirty. */
export const manualGitLocalSchema = z.object({
  branch: gitBranchSchema,
  head: gitShaSchema,
  commit: gitShaSchema,
  dirty: z.boolean(),
  changedFiles: z.number().int().nonnegative(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  commits: z.string().max(8000),
  stat: z.string().max(8000),
  diff: z.string().max(16_000),
});

export type ManualGitLocal = z.infer<typeof manualGitLocalSchema>;

/** `manual-git-check` checkpoint: local state plus the broker's view of the remote. */
export const manualGitCheckSchema = z.object({
  action: z.enum(["push", "pr"]),
  generation: z.number().int().positive(),
  local: manualGitLocalSchema,
  defaultBranch: gitBranchSchema,
  /** Remote head the confirmation was based on; a different head at push time is stale. */
  expectedHead: gitShaSchema.nullable(),
  push: gitPushImpactSchema,
  pr: gitPrImpactSchema.nullable(),
});

export type ManualGitCheck = z.infer<typeof manualGitCheckSchema>;

/** `manual-git-result` checkpoint, written before a manual run completes. */
export const manualGitResultSchema = z.object({
  commit: gitShaSchema,
  branch: gitBranchSchema,
  pullRequest: z.object({ number: z.number().int().positive(), url: z.url() }).nullable(),
});

export type ManualGitResult = z.infer<typeof manualGitResultSchema>;

export const manualGitTextSchema = z.object({
  commitMessage: z.string().trim().min(1).max(4000),
  title: z.string().trim().min(1).max(256),
  body: z.string().max(60_000),
});

export type ManualGitText = z.infer<typeof manualGitTextSchema>;

export function manualGitFallback(local: ManualGitLocal): ManualGitText {
  const subject = local.commits.split("\n").find((line) => line.trim()) ?? `Update ${local.branch}`;

  return {
    commitMessage: subject.slice(0, 4000),
    title: subject.slice(0, 256),
    body: local.commits || `Changes on ${local.branch}.`,
  };
}
