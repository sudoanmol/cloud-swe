import type { EventIndexRow, ThreadEvent } from "@cloud-swe/db/thread-contracts";
import { z } from "zod";

export type ReplayStore = {
  listEventIndex(input: {
    threadId: string;
    after: number;
    through: number;
    limit: number;
  }): Promise<EventIndexRow[]>;
  listEventsAt(input: { threadId: string; sequences: readonly number[] }): Promise<ThreadEvent[]>;
};

/** Committed events covering `(after, through]`; omitted sequences are proven redundant. */
export type ReplayPage = { after: number; through: number; events: ThreadEvent[] };

const indexWindow = 1_000;

/** The open run of contiguous deltas: its identity and first and last sequences. */
type DeltaRunState = { open: { identity: string; first: number; last: number } | null };

const textIdentitySchema = z.object({
  runId: z.string().min(1),
  attemptId: z.string().min(1),
  assistantAttempt: z.number().int().positive(),
  messageIndex: z.number().int().positive(),
});

function textIdentity(row: EventIndexRow): string | null {
  const parsed = textIdentitySchema.safeParse(row);

  return parsed.success
    ? JSON.stringify([
        parsed.data.runId,
        parsed.data.attemptId,
        parsed.data.assistantAttempt,
        parsed.data.messageIndex,
      ])
    : null;
}

/**
 * Plans which committed sequences a replay must send. One case is compacted: a
 * contiguous run of `assistant.delta` events followed directly by the
 * `assistant.message` with the same full identity and untruncated content. That
 * message replaces the streamed text, so only the first delta (which places the
 * part) and the message are sent, always in the same page. Every page therefore
 * ends where the projection equals a full replay. Everything else is sent as is.
 */
export async function* planReplay(
  store: Pick<ReplayStore, "listEventIndex">,
  input: { threadId: string; after: number; through: number; pageSize: number },
): AsyncGenerator<{ after: number; through: number; sequences: number[] }> {
  let pageAfter = input.after;
  let sequences: number[] = [];
  // Held in an object because the generator helpers below replace the open run.
  const run: DeltaRunState = { open: null };
  let cursor = input.after;

  // A compacted pair is pushed together, so a page may run one past the size.
  const flush = function* (force: boolean) {
    if (sequences.length === 0 || (!force && sequences.length < input.pageSize)) return;

    const through = sequences.at(-1) ?? pageAfter;

    yield { after: pageAfter, through, sequences };
    pageAfter = through;
    sequences = [];
  };

  const release = function* () {
    const open = run.open;

    if (!open) return;
    run.open = null;

    for (let sequence = open.first; sequence <= open.last; sequence += 1) {
      sequences.push(sequence);
      yield* flush(false);
    }
  };

  while (cursor < input.through) {
    const rows = await store.listEventIndex({
      threadId: input.threadId,
      after: cursor,
      through: input.through,
      limit: indexWindow,
    });

    if (!rows.length) break;

    for (const row of rows) {
      cursor = row.sequence;
      const identity = row.type.startsWith("assistant.") ? textIdentity(row) : null;

      if (row.type === "assistant.delta" && identity) {
        if (run.open?.identity === identity && run.open.last + 1 === row.sequence) {
          run.open.last = row.sequence;
          continue;
        }

        yield* release();
        run.open = { identity, first: row.sequence, last: row.sequence };
        continue;
      }

      if (
        row.type === "assistant.message" &&
        identity &&
        run.open?.identity === identity &&
        run.open.last + 1 === row.sequence &&
        row.contentTruncated !== true
      ) {
        // Keep the pair in one page: the first delta places the part, the
        // message supplies its final text.
        sequences.push(run.open.first, row.sequence);
        run.open = null;
        yield* flush(false);
        continue;
      }

      yield* release();
      sequences.push(row.sequence);
      yield* flush(false);
    }
  }

  yield* release();
  yield* flush(true);
}

/** Replay pages with their event bodies, read only for the sequences sent. */
export async function* replayPages(
  store: ReplayStore,
  input: { threadId: string; after: number; through: number; pageSize: number },
): AsyncGenerator<ReplayPage> {
  for await (const page of planReplay(store, input)) {
    const events = await store.listEventsAt({
      threadId: input.threadId,
      sequences: page.sequences,
    });

    if (events.length !== page.sequences.length)
      throw new Error("Committed events disappeared during replay");

    yield { after: page.after, through: page.through, events };
  }
}
