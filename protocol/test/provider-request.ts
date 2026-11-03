/**
 * Path: protocol/test/provider-request.ts
 * Used by: server/test/{approvals.test,codemode.test,command-recovery.test,e2b-live.test,egress.test,environment-delivery.test,git-clone-access.test,interaction.test,lifecycle.test,pull-requests.test,tools.test,web.test}.ts.
 * Purpose: Reads tool results out of a captured model request, for tests that assert what the model was told.
 */

import { z } from 'zod';

const Text = z.object({ type: z.literal('text'), text: z.string() });

const Result = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
  content: z.union([z.string(), z.array(Text)]).optional(),
});

const Request = z.object({
  messages: z.array(
    z.object({
      content: z.union([z.string(), z.array(z.union([Result, z.object({ type: z.string() }).transform(() => null)]))]),
    }),
  ),
});

// Inspect actual tool results, not an earlier assistant's script containing the expected text.
export function toolResults(body: string) {
  return Request.parse(JSON.parse(body)).messages.flatMap(({ content }) => {
    if (!Array.isArray(content)) return [];

    return content.flatMap((block) =>
      block === null
        ? []
        : [
            {
              callId: block.tool_use_id,
              isError: block.is_error ?? false,
              output: Array.isArray(block.content)
                ? block.content.map(({ text }) => text).join('\n')
                : (block.content ?? ''),
            },
          ],
    );
  });
}
