/**
 * Path: server/src/sessions/transcript.ts
 * Used by: server/src/sessions/{thread,events}.ts.
 * Purpose: Projects the native Pi transcript and live state into protocol snapshots and paginated history, without copying it.
 */
import { Entry, EntryId, HistoryResponse, PageQuery, Session, Snapshot } from '@cloud-swe/protocol';
import { NativeContent, NativeLive } from '@cloud-swe/protocol/native';
import { HistoryPosition } from '@cloud-swe/protocol/storage';
import type { OpenCommandOperation } from '@cloud-swe/protocol/tools';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import type { ConversationView, Cursor, EntryRecord } from '@earendil-works/pi-durable';
import type { PiHarness } from 'agents/harness/pi';

import { apiError } from '../http';
import { liveTools, toolArguments, toolResultEntry } from './tool-projection';

const plain = (record: EntryRecord): NonNullable<Entry['native']> => JSON.parse(JSON.stringify(record));

// Entries carry no raw `native` record; paginated history adds it, snapshots and SSE frames stay small.
function project(
  session: Session,
  record: EntryRecord,
  args: ReturnType<typeof toolArguments>,
  commands: readonly OpenCommandOperation[],
): Entry {
  const tool = toolResultEntry(record, args, commands);

  if (tool) return tool;
  const id = EntryId.parse(String(record.id));
  const message = record.model?.length === 1 ? record.model[0] : undefined;
  const createdAt = message ? new Date(message.timestamp).toISOString() : session.createdAt;
  const content = message ? NativeContent.parse(message.content) : [];

  if (message && (message.role === 'user' || message.role === 'assistant') && content.length > 0) {
    return Entry.parse({
      id,
      createdAt,
      kind: 'message',
      role: message.role,
      content,
      status: message.role === 'assistant' && message.stopReason === 'aborted' ? 'interrupted' : 'committed',
    });
  }

  return Entry.parse({ id, createdAt, kind: 'native', nativeKind: record.kind, payload: plain(record) });
}

function encodePosition(session: Session, native: Cursor) {
  return btoa(JSON.stringify(HistoryPosition.parse({ sessionId: session.id, native })));
}

export async function history(
  harness: PiHarness,
  session: Session,
  raw: PageQuery,
  commands: readonly OpenCommandOperation[],
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

  const records = [...page.items].reverse();

  const projectAll = (args: ReturnType<typeof toolArguments>) =>
    records.map((record) => ({ ...project(session, record, args, commands), native: plain(record) }));

  let entries = projectAll(toolArguments(records));

  // A tool result's call is in the assistant message just before it, which may be on the next (older) page.
  // One extra page covers any realistic parallel-call fan-out; a call beyond it stays truthfully null.
  if (page.next && entries.some((entry) => entry.kind === 'tool' && entry.arguments === null)) {
    const older = await root.entries({ order: 'descending' }, 100, page.next, BG);

    entries = projectAll(toolArguments([...older.items, ...records]));
  }

  return HistoryResponse.parse({
    entries,
    nextCursor: page.next ? encodePosition(session, page.next) : null,
  });
}

export async function snapshotFromView(
  harness: PiHarness,
  session: Session,
  view: ConversationView,
  commands: readonly OpenCommandOperation[],
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
          createdAt: new Date(message.timestamp).toISOString(),
          kind: 'message',
          role: 'assistant',
          status: 'streaming',
          content: message.content,
        }),
      );
  }

  const tools = await liveTools(harness, view, commands);

  return Snapshot.parse({
    session,
    tools: tools.slice(0, 100),
    toolsTruncated: tools.length > 100,
    history: {
      entries,
      nextCursor: first ? encodePosition(session, { after: Number(first.id), order: 'descending' }) : null,
    },
  });
}
