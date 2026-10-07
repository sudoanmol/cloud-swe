/**
 * The environment last picked for a new thread, per account. Only the ID is
 * stored; names, flags, and values stay on the server.
 */
const KEY_PREFIX = "cloud-swe:environment-selection";

export function environmentSelectionKey(userId: string): string {
  return `${KEY_PREFIX}:${userId}`;
}

export function readEnvironmentSelection(userId: string): string | null {
  return window.localStorage.getItem(environmentSelectionKey(userId));
}

export function writeEnvironmentSelection(userId: string, environmentId: string | null): void {
  if (environmentId) window.localStorage.setItem(environmentSelectionKey(userId), environmentId);
  else window.localStorage.removeItem(environmentSelectionKey(userId));
}
