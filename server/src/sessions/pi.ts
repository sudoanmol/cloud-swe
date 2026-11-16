import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import type { PiHarness } from 'agents/harness/pi';

/** The session's one native Pi root conversation. */
export async function rootConversation(harness: PiHarness) {
  return (await harness.pi()).root(BG);
}
