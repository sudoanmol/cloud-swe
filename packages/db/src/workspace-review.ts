import { z } from "zod";

/**
 * Browser-safe contracts for the workspace review panel and the live diff
 * count. The guest program in `workspace-review-program.ts` produces these
 * shapes; callers validate its untrusted output here.
 */

/**
 * Changes against the merge-base of HEAD and the branch tip the clone started
 * from, plus the checkout's current branch, commit and uncommitted state.
 */
export const workspaceDiffStatSchema = z.object({
  files: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  branch: z.string().max(255).nullable().default(null),
  head: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .nullable()
    .default(null),
  dirty: z.boolean().default(false),
});

export type WorkspaceDiffStat = z.infer<typeof workspaceDiffStatSchema>;

export const reviewModeSchema = z.enum(["all", "uncommitted", "commit"]);

export type ReviewMode = z.infer<typeof reviewModeSchema>;

export const reviewCommitSchema = z.object({
  sha: z.string(),
  shortSha: z.string(),
  subject: z.string(),
  author: z.string(),
  timestamp: z.number().int(),
});

export type ReviewCommit = z.infer<typeof reviewCommitSchema>;

/** `null` when /workspace is not a Git repository. */
export const reviewSummarySchema = z
  .object({
    head: z.string().nullable(),
    base: z.string().nullable(),
    commits: z.array(reviewCommitSchema),
    commitsTruncated: z.boolean(),
  })
  .nullable();

export type ReviewSummary = z.infer<typeof reviewSummarySchema>;

export const reviewFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  binary: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

export type ReviewFile = z.infer<typeof reviewFileSchema>;

export const reviewDiffSchema = z
  .object({
    files: z.array(reviewFileSchema),
    patch: z.string(),
    patchTruncated: z.boolean(),
  })
  .nullable();

export type ReviewDiff = z.infer<typeof reviewDiffSchema>;

export const workspacePathsSchema = z.object({
  paths: z.array(z.string()),
  truncated: z.boolean(),
});

export type WorkspacePaths = z.infer<typeof workspacePathsSchema>;

/** Listening TCP ports in the sandbox, ascending. */
export const workspacePortsSchema = z.array(z.number().int().min(1).max(65_535));

/** Listening ports with their preview URLs, for the browser panel. */
export const workspacePreviewsSchema = z.object({
  ports: z.array(z.object({ port: z.number().int(), url: z.url() })),
});

export type WorkspacePreviews = z.infer<typeof workspacePreviewsSchema>;

export const workspaceFileSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), path: z.string(), size: z.number(), contents: z.string() }),
  z.object({ kind: z.literal("binary"), path: z.string(), size: z.number() }),
  z.object({ kind: z.literal("too-large"), path: z.string(), size: z.number() }),
]);

export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;

/** Every guest response is wrapped so expected failures are not process errors. */
export function reviewEnvelopeSchema<T extends z.ZodType>(result: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), result }),
    z.object({ ok: z.literal(false), error: z.string().max(1_000) }),
  ]);
}
