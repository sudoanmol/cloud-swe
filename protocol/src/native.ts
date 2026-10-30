import { z } from 'zod';

import { ContentBlock } from './index.ts';

// Parse the Pi document/model boundary; unrecognized blocks remain in the raw native payload.
export const NativeContent = z.union([
  z.string().transform((text) => [ContentBlock.parse({ kind: 'text', text })]),
  z
    .array(
      z.union([
        z
          .object({ type: z.literal('text'), text: z.string() })
          .transform(({ text }) => ContentBlock.parse({ kind: 'text', text })),
        z
          .object({ type: z.literal('thinking'), thinking: z.string() })
          .transform(({ thinking }) => ContentBlock.parse({ kind: 'reasoning', text: thinking })),
        z.object({ type: z.string() }).transform(() => null),
      ]),
    )
    .transform((blocks) => blocks.flatMap((block) => (block ? [block] : []))),
]);

export const NativeLive = z.object({
  generation: z
    .object({
      message: z.object({ role: z.literal('assistant'), content: NativeContent, timestamp: z.number() }).optional(),
    })
    .optional(),
});
