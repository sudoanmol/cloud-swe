/**
 * Composer drafts, keyed by account and by thread (or the new-thread route), so
 * a draft never leaks to another thread or another signed-in account. Stored in
 * `sessionStorage` so a reload or a full page navigation keeps the text while
 * closing the tab discards it.
 */
const PREFIX = "cloud-swe:draft";

function storageKey(userId: string, key: string): string {
  return `${PREFIX}:${userId}:${key}`;
}

function storage(): Storage | null {
  return typeof window === "undefined" ? null : window.sessionStorage;
}

export function readDraft(userId: string, key: string): string {
  return storage()?.getItem(storageKey(userId, key)) ?? "";
}

export function writeDraft(userId: string, key: string, value: string): void {
  const store = storage();

  if (!store) return;

  if (value.length === 0) store.removeItem(storageKey(userId, key));
  else store.setItem(storageKey(userId, key), value);
}

export function clearDraft(userId: string, key: string): void {
  storage()?.removeItem(storageKey(userId, key));
}
