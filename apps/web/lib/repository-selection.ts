import { z } from "zod";

/**
 * The last repository and branch picked for a new thread, per account. Kept in
 * `localStorage` like the model selection so it survives reloads and new tabs;
 * the picker only restores it while the repository is still available.
 */
const KEY_PREFIX = "cloud-swe:repository-selection";

const repositorySelectionSchema = z.object({
  url: z.string(),
  branch: z.string().nullable(),
});

export type RepositorySelection = z.infer<typeof repositorySelectionSchema>;

export function repositorySelectionKey(userId: string): string {
  return `${KEY_PREFIX}:${userId}`;
}

export function readRepositorySelection(userId: string): RepositorySelection | null {
  const raw = window.localStorage.getItem(repositorySelectionKey(userId));

  if (!raw) return null;

  try {
    const parsed = repositorySelectionSchema.safeParse(JSON.parse(raw));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeRepositorySelection(userId: string, selection: RepositorySelection): void {
  window.localStorage.setItem(repositorySelectionKey(userId), JSON.stringify(selection));
}
