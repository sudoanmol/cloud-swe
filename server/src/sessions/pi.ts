/**
 * Path: server/src/sessions/pi.ts
 * Used by: server/src/sessions/{cancellation,catalog-store,compaction,messages,notice,projection,summary,thread,transcript}.ts.
 * Purpose: The one way the server reaches a Pi conversation: by the session's ConversationId, which is Pi's own ID as a string.
 */

import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import {
  type Conversation,
  type ConversationId as PiConversationId,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable';
import type { PiHarness } from 'agents/harness/pi';

/** The conversation every session starts on, as the session names it ("1"). Pi creates it when the harness opens. */
export const FIRST_CONVERSATION = String(ROOT_CONVERSATION_ID);

/**
 * Pi's handle on the conversation the session names `id` (a ConversationId: Pi's own ID as a decimal string), or
 * undefined when the session has none with that ID. Never creates one.
 */
export async function openConversation(harness: PiHarness, id: string): Promise<Conversation | undefined> {
  const native = Number(id);

  // Pi reads any spelling of a number ("01", "1e0") as the same conversation; only its own spelling addresses one.
  if (!Number.isSafeInteger(native) || native < 1 || String(native) !== id) return undefined;

  // SAFETY: a positive safe integer is the shape of every Pi conversation ID, and Pi answers whether this one exists.
  return (await harness.pi()).conversation(native as PiConversationId, BG);
}

/** As openConversation, for a conversation the session already refers to: a missing one is corruption. */
export async function requireConversation(harness: PiHarness, id: string): Promise<Conversation> {
  const conversation = await openConversation(harness, id);

  if (!conversation) throw new Error('Missing Pi conversation');

  return conversation;
}

/** The ID of the conversation's newest entry, its parent's entries included; 0 when it has none. */
export async function newestEntryId(conversation: Conversation): Promise<number> {
  const page = await conversation.entries({ order: 'descending' }, 1, undefined, BG);

  return Number(page.items[0]?.id ?? 0);
}
