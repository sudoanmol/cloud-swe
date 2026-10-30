import { Entry, EntryId, HistoryResponse, PageQuery, Session, Snapshot } from '@cloud-swe/protocol';
import { NativeContent, NativeLive } from '@cloud-swe/protocol/native';
import { HistoryPosition } from '@cloud-swe/protocol/storage';
import type { CommandOperation } from '@cloud-swe/protocol/tools';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import type { ConversationView, Cursor, EntryRecord } from '@earendil-works/pi-durable';
import type { PiHarness } from 'agents/harness/pi';

import { apiError } from '../http';
import { liveTools, toolArguments, toolResultEntry } from './tool-projection';

function project(
  session: Session,
  record: EntryRecord,
  args: ReturnType<typeof toolArguments>,
  commands: readonly CommandOperation[],
): Entry {
  const tool = toolResultEntry(record, args, commands);

  if (tool) return tool;
  const id = EntryId.parse(String(record.id));
  const message = record.model?.length === 1 ? record.model[0] : undefined;
  const native: unknown = JSON.parse(JSON.stringify(record));
  const createdAt = message ? new Date(message.timestamp).toISOString() : session.createdAt;
  const content = message ? NativeContent.parse(message.content) : [];

  if (message && (message.role === 'user' || message.role === 'assistant') && content.length > 0) {
    return Entry.parse({
      id,
      runId: null,
      createdAt,
      kind: 'message',
      role: message.role,
      content,
      native,
      status: message.role === 'assistant' && message.stopReason === 'aborted' ? 'interrupted' : 'committed',
    });
  }

  return Entry.parse({ id, runId: null, createdAt, kind: 'native', nativeKind: record.kind, payload: native });
}

function encodePosition(session: Session, native: Cursor) {
  return btoa(JSON.stringify(HistoryPosition.parse({ sessionId: session.id, native })));
}

export async function history(
  harness: PiHarness,
  session: Session,
  raw: PageQuery,
  commands: readonly CommandOperation[],
) {
  const query = PageQuery.parse(raw);
  let native: HistoryPosition['native'] | undefined;

  if (query.cursor) {
    try {
      const position = HistoryPosition.parse(JSON.parse(atob(query.cursor)));

      if (position.sessionId !== session.id)
        return apiError(400, 'invalid_request', 'History cursor belongs to another session');
      native = position.native;
    } catch {
      return apiError(400, 'invalid_request', 'Invalid history cursor');
    }
  }

  const root = await (await harness.pi()).root(BG);
  const page = await root.entries({ order: 'descending' }, query.limit, native, BG);

  const args = toolArguments(page.items);

  return HistoryResponse.parse({
    entries: [...page.items].reverse().map((record) => project(session, record, args, commands)),
    nextCursor: page.next ? encodePosition(session, page.next) : null,
  });
}

export async function snapshotFromView(
  harness: PiHarness,
  session: Session,
  view: ConversationView,
  commands: readonly CommandOperation[],
): Promise<Snapshot> {
  // Snapshot is the bounded active context; history includes older entries across compaction/reset boundaries.
  const records = view.entries.slice(-99);
  const args = toolArguments(view.entries);
  const entries = records.map((record) => project(session, record, args, commands));
  const first = records[0];
  const live = view.docs['pi.live'];

  const partial = NativeLive.safeParse(live);

  if (partial.success && partial.data.generation?.message) {
    const message = partial.data.generation.message;

    if (message.content.length > 0)
      entries.push(
        Entry.parse({
          id: EntryId.parse('live'),
          runId: 'runId' in session.run ? session.run.runId : null,
          createdAt: session.updatedAt,
          kind: 'message',
          role: 'assistant',
          status: 'streaming',
          content: message.content,
          native: live,
        }),
      );
  }

  const tools = await liveTools(harness, view, commands);

  return Snapshot.parse({
    session,
    tools: tools.slice(0, 100),
    toolsTruncated: tools.length > 100,
    native: live,
    history: {
      entries,
      nextCursor: first ? encodePosition(session, { after: Number(first.id), order: 'descending' }) : null,
    },
  });
}
