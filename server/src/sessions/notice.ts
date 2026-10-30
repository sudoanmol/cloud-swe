/**
 * Path: server/src/sessions/notice.ts
 * Used by: server/src/sessions/{thread,messages,transcript,message-state}.ts.
 * Purpose: The server-written notice a model receives once when its sandbox was replaced, and the native Pi entry that carries it.
 */
import type { EntryDraft } from '@earendil-works/pi-durable';

// Not `pi.*`: an application kind. The entry's model message is the notice; clients never see it.
export const NOTICE_KIND = 'cloud-swe.sandbox-replaced';

/** Request IDs of notice writes. They share Pi's request namespace with message operations. */
export const NOTICE_PREFIX = 'notice:';

/**
 * The text the model sees once after its sandbox was deleted and replaced.
 * `repos` describes the repositories and session branches known before the deletion, one per line.
 */
export function sandboxReplacedNotice(repos: readonly string[]): string {
  const known =
    repos.length === 0
      ? ''
      : `\n\nRepositories and session branches known before the deletion:\n${repos.map((r) => `- ${r}`).join('\n')}`;

  return (
    'Your previous sandbox was deleted after a long period of inactivity and this is a new, empty one. ' +
    'Earlier file edits in this conversation no longer exist here. ' +
    'Check for pushed work and re-clone it before continuing. ' +
    "If you can't find the work, tell the user what's gone and ask where to go next instead of guessing." +
    known
  );
}

/** A passive write: it adds the notice to the model's context without being anyone's message. */
export function noticeEntry(notice: string): EntryDraft {
  return {
    kind: NOTICE_KIND,
    data: { replacedSandbox: true },
    model: [{ role: 'user', content: notice, timestamp: Date.now() }],
  };
}
