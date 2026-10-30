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
  // MessageOperation.notice holds 4000 characters, and an oversized notice would block every later message.
  let room = 2500;

  const listed = repos
    .values()
    .filter((repo) => (room -= repo.length + 3) >= 0)
    .map((repo) => `- ${repo}`)
    .toArray();

  const omitted = repos.length - listed.length;

  const known =
    repos.length === 0
      ? ''
      : `\n\nRepositories and session branches known before the deletion:\n${listed.join('\n')}${omitted > 0 ? `\n- and ${omitted} more` : ''}`;

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
