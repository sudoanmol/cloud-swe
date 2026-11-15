/**
 * Path: server/src/follow-ups.ts
 * Used by: server/src/git/approvals.ts, server/src/sessions/thread.ts, server/src/tools/{questions,secret-requests}.ts.
 * Purpose: Requests a person decides later (approvals, questions, secret requests): their records in Thread storage, the list clients see, and the delivery of each outcome to the agent as one message.
 */

import { SubmitMessageRequest } from '@cloud-swe/protocol';
import type { z } from 'zod';

import { deterministicUuid } from './ids.ts';
import { type KvLister, type KvReader, type KvWriter, listParsed, readParsed } from './storage.ts';

export type FollowUpHost = {
  storage: KvReader & KvWriter & KvLister;
  // Whether the session admitted the message. Admission is idempotent on the operation ID.
  deliver: (request: SubmitMessageRequest) => Promise<boolean>;
  // Makes sure the durable delivery job will retry whatever a decision leaves undelivered.
  armDelivery: () => Promise<void>;
  // Tells connected clients the session's requests changed; Pi doesn't publish them.
  changed: () => void;
};

/** The message an item's current state owes the agent. `key` names that outcome, so admitting it twice is harmless. */
type Outcome = { key: string; mode: SubmitMessageRequest['mode']; text: string };

// This many of the newest items that are no longer open stay visible, so clients can render outcomes.
export const RECENT = 20;

/**
 * A person can take days to decide, so the tool that files a request returns at once and the outcome arrives later as a
 * message. A refused delivery stays owed, and the Thread's delivery job retries it.
 */
export function followUps<Stored extends { delivered: boolean }, Item extends { id: string; createdAt: string }>(kind: {
  prefix: string;
  schema: z.ZodType<Stored>;
  item: (stored: Stored) => Item;
  /** Still waiting on the person. Open items always show. */
  isOpen: (item: Item) => boolean;
  outcome: (item: Item) => Outcome | undefined;
}) {
  const read = (storage: KvReader, id: string) => readParsed(storage, kind.prefix + id, kind.schema);

  const write = (storage: KvWriter, stored: Stored) =>
    storage.put(kind.prefix + kind.item(stored).id, kind.schema.parse(stored));

  const list = async (storage: KvLister) =>
    (await listParsed(storage, kind.prefix, kind.schema)).toSorted((a, b) =>
      kind.item(a).createdAt.localeCompare(kind.item(b).createdAt),
    );

  const owed = (stored: Stored) => (stored.delivered ? undefined : kind.outcome(kind.item(stored)));

  /** Sends the outcome the record owes, if any, and returns the record as it then stands. */
  async function deliver(host: FollowUpHost, stored: Stored): Promise<Stored> {
    const outcome = owed(stored);

    if (!outcome) return stored;
    // Parsed, so its keys are in the order a stored record reads back in.
    const item = kind.item(kind.schema.parse(stored));

    const admitted = await host
      .deliver(
        SubmitMessageRequest.parse({
          operationId: await deterministicUuid(outcome.key),
          mode: outcome.mode,
          text: outcome.text,
        }),
      )
      .catch(() => false);

    if (!admitted) return stored;

    // A decision may have moved the record on while the message was admitted; that outcome is delivered on its own.
    const latest = await read(host.storage, item.id);

    if (!latest || JSON.stringify(kind.item(latest)) !== JSON.stringify(item)) return latest ?? stored;
    const next = { ...latest, delivered: true };
    await write(host.storage, next);

    return next;
  }

  return {
    read,
    write,
    deliver,

    async openCount(storage: KvLister): Promise<number> {
      return (await list(storage)).filter((stored) => kind.isOpen(kind.item(stored))).length;
    },

    /** Open items plus the newest ones that are no longer open, oldest first. */
    async visible(storage: KvLister): Promise<Item[]> {
      const all = (await list(storage)).map(kind.item);
      const closed = all.filter((item) => !kind.isOpen(item)).slice(-RECENT);

      return all.filter((item) => kind.isOpen(item) || closed.includes(item));
    },

    /** Delivers every outcome still owed. Returns whether any remains. `deciding` names items a decision is working on. */
    async deliverAll(host: FollowUpHost, deciding?: (id: string) => boolean): Promise<boolean> {
      let remaining = false;

      for (const stored of await list(host.storage)) {
        // A decision in flight delivers its own result; stay scheduled in case that delivery is refused.
        if (deciding?.(kind.item(stored).id)) remaining = true;
        else if (owed(stored) && !(await deliver(host, stored)).delivered) remaining = true;
      }

      return remaining;
    },
  };
}
