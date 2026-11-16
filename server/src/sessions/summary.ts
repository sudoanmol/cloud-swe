/**
 * Path: server/src/sessions/summary.ts
 * Used by: server/src/sessions/{catalog,thread}.ts.
 * Purpose: A session's list row: what it holds, which Pi commits can move it, and the Thread's writer that sends it to the Catalog only when it changed, retrying a failed write.
 */

import { SESSION_PREVIEW_LIMIT, type SessionSummary, sessionSummary } from '@cloud-swe/protocol';
import { NativeContent } from '@cloud-swe/protocol/native';
import { StoredSessionSummary } from '@cloud-swe/protocol/storage';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import type { CommitPublication, Cursor, EntryRecord } from '@earendil-works/pi-durable';

import { catalogStub } from '../env.ts';
import { logFault } from '../errors.ts';
import { PollingJob } from '../polling-job.ts';
import type { ToolHost } from '../sandbox/host.ts';
import { readSession } from '../thread-store.ts';
import { NOTICE_KIND } from './notice.ts';
import { requireConversation } from './pi.ts';
import { sessionProjection } from './projection.ts';

// A failed write is tried again this often until the Catalog takes it.
const RETRY_MS = 30_000;

export const storedSummary = ({ id, ...summary }: SessionSummary): StoredSessionSummary =>
  StoredSessionSummary.parse({ sessionId: id, ...summary });

/** The start of an entry's text if it is a user or assistant message with any; never the model-only notice. */
function messageText(record: EntryRecord): string | undefined {
  const message = record.model?.length === 1 ? record.model[0] : undefined;

  if (record.kind === NOTICE_KIND || (message?.role !== 'user' && message?.role !== 'assistant')) return undefined;

  const text = NativeContent.parse(message.content)
    .flatMap((block) => (block.kind === 'text' ? [block.text] : []))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Cut by UTF-16 units, as the limit counts, without leaving half of a surrogate pair.
  return text ? text.slice(0, SESSION_PREVIEW_LIMIT).replace(/[\uD800-\uDBFF]$/, '') : undefined;
}

/** The newest message with text, which a run of tool calls can put several pages back. */
async function preview(host: ToolHost, conversationId: string): Promise<string | null> {
  const conversation = await requireConversation(host.harness, conversationId);
  let cursor: Cursor | undefined;

  do {
    const page = await conversation.entries({ order: 'descending' }, 50, cursor, BG);
    const text = page.items.map(messageText).find(Boolean);

    if (text) return text;
    cursor = page.next;
  } while (cursor);

  return null;
}

/** The session's list row, from local storage and Pi only. */
async function summaryRow(host: ToolHost): Promise<StoredSessionSummary> {
  // The list doesn't show the sandbox's state, so this never asks the Catalog for it.
  const session = await sessionProjection(host, 'unreachable');

  return storedSummary(sessionSummary(session, await preview(host, session.activeConversationId)));
}

/**
 * Whether a Pi commit can move the row: one that writes an entry, submission, task or conversation. Commits of documents
 * alone, such as streamed text or tool output, cannot, and they come many times a second.
 */
export const movesSummary = (publication: CommitPublication) =>
  publication.changes.some((change) => change.type !== 'document' && change.type !== 'document.copy');

/**
 * Keeps the Catalog's copy of the row current. `changed()` is called after anything that can move it; writes run one at
 * a time, and a change during a write queues one more. The last row written is kept in memory, so a write is sent only
 * when the row differs; after an eviction the first change writes again. A failed write arms `retry`, a durable job
 * that tries until the Catalog takes it. `start` starts the Thread, which happens only for a session it holds.
 */
export function summaryWriter(host: ToolHost, start: () => Promise<void>) {
  let written: string | undefined;
  let queued = false;
  let chain = Promise.resolve();

  const serial = (work: () => Promise<void>) => {
    const run = chain.then(work);
    chain = run.catch(() => undefined);

    return run;
  };

  const sync = async () => {
    if ((await readSession(host.storage)) === undefined) return;
    await start();
    const row = await summaryRow(host);

    if (JSON.stringify(row) === written) return;
    await catalogStub(host.env).writeSummary(row);
    written = JSON.stringify(row);
  };

  const retry = new PollingJob({
    capability: 'summary-retry',
    job: 'summary-retry',
    step: async () => {
      await serial(sync);

      return false;
    },
    everyMs: () => RETRY_MS,
  });

  const changed = () => {
    if (queued) return;
    queued = true;

    void serial(async () => {
      queued = false;
      await sync();
    }).catch(async (error) => {
      if (error instanceof Error) logFault('Session summary write failed', error);
      // Nothing is left to try if even the job can't be stored; the next change writes again.
      await retry.watch().catch(() => undefined);
    });
  };

  return { changed, retry };
}
