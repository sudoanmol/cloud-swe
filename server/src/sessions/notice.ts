/**
 * Path: server/src/sessions/notice.ts
 * Used by: server/src/sessions/{cancellation,messages,summary,transcript,workspace-ready}.ts.
 * Purpose: Server-written notices for the model (a replaced sandbox, or a follow-up a cancellation withdrew) and the native Pi entry that carries them.
 */

import { NOTICE_LIMIT } from '@cloud-swe/protocol/storage';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import type { EntryDraft } from '@earendil-works/pi-durable';
import type { PiHarness } from 'agents/harness/pi';

import { requireConversation } from './pi.ts';

// Not `pi.*`: an application kind. The entry's model message is the notice; clients never see it.
export const NOTICE_KIND = 'cloud-swe.notice';

// Request IDs of notice writes. They share Pi's request namespace with message operations.
const NOTICE_PREFIX = 'notice:';

/** Whether a Pi request ID is a notice write rather than a message. */
export const isNotice = (requestId: string) => requestId.startsWith(NOTICE_PREFIX);

/**
 * The text the model sees once after its sandbox was deleted and replaced.
 * `repos` describes the repositories and session branches known before the deletion, one per line.
 */
export function sandboxReplacedNotice(repos: readonly string[]): string {
  // An oversized notice would block every later message, so the list gets what the fixed text leaves, with a margin.
  let room = NOTICE_LIMIT - 1500;

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

/**
 * Adds model-only context to the conversation as a passive write: it is in the model's context without being anyone's
 * message. `key` makes the write idempotent, so a retry never adds it twice.
 */
export async function writeNotice(harness: PiHarness, conversationId: string, key: string, notice: string) {
  const entry: EntryDraft = {
    kind: NOTICE_KIND,
    data: {},
    model: [{ role: 'user', content: notice, timestamp: Date.now() }],
  };

  const conversation = await requireConversation(harness, conversationId);

  await conversation.submit({ type: 'write', requestId: NOTICE_PREFIX + key, entry }, BG);
}
