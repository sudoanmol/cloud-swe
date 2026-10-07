import { environmentSelectionKey } from "./environment-selection";
import { repositorySelectionKey } from "./repository-selection";

/** Remove only the departing account's drafts and unresolved submissions. */
export function clearAccountStorage(userId: string, session: Storage, local: Storage): void {
  for (let index = session.length - 1; index >= 0; index--) {
    const key = session.key(index);

    if (
      key?.startsWith(`cloud-swe:draft:${userId}:`) ||
      key?.startsWith(`cloud-swe:submission:${userId}:`)
    )
      session.removeItem(key);
  }

  local.removeItem(`cloud-swe:model-selection:${userId}`);
  local.removeItem(repositorySelectionKey(userId));
  local.removeItem(environmentSelectionKey(userId));
}
