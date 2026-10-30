import { z } from 'zod';

import { ToolCallId, ToolName, type ContentBlock } from './index.ts';

// Parse the Pi document/model boundary; unrecognized (or over-limit) blocks remain in the raw native payload.
// Transforms must not throw: limits live in the schemas so a violation falls through to the catch-all.
export const NativeContent = z.union([
  z.string().transform((text): ContentBlock[] => [{ kind: 'text', text }]),
  z
    .array(
      z.union([
        z
          .object({ type: z.literal('text'), text: z.string() })
          .transform(({ text }) => ({ kind: 'text' as const, text })),
        z
          .object({ type: z.literal('thinking'), thinking: z.string() })
          .transform(({ thinking }) => ({ kind: 'reasoning' as const, text: thinking })),
        z
          .object({
            type: z.literal('toolCall'),
            id: ToolCallId,
            name: ToolName,
            arguments: z.record(z.string(), z.json()),
          })
          .transform(({ id, name, arguments: args }) => ({
            kind: 'tool_call' as const,
            toolCallId: id,
            name,
            arguments: args,
          })),
        z.object({ type: z.string() }).transform(() => null),
      ]),
    )
    .transform((blocks): ContentBlock[] => blocks.flatMap((block) => (block ? [block] : []))),
]);

export const NativeDiagnostic = z.object({ severity: z.string(), code: z.string().optional(), message: z.string() });

export const NativeToolData = z.object({ diagnostics: z.array(NativeDiagnostic) });

export const NativeToolResult = z.object({
  role: z.literal('toolResult'),
  toolCallId: ToolCallId,
  toolName: ToolName,
  content: NativeContent,
  isError: z.boolean(),
  timestamp: z.number(),
  details: z.json().optional(),
  structuredOutput: z.json().optional(),
});

export const NativeNestedResult = z.object({
  isError: z.boolean(),
  structuredOutput: z.json().optional(),
  details: z.json().optional(),
  diagnostics: z.array(NativeDiagnostic),
});

export type NativeNestedResult = z.infer<typeof NativeNestedResult>;

export const NativeNestedText = z.union([
  z.string(),
  z.object({ output: z.string() }).transform(({ output }) => output),
]);

export const NativeCodemodeDetails = z.object({
  calls: z.array(
    z.object({
      id: z.number().int().positive(),
      name: z.string(),
      args: z.string(),
      status: z.enum(['running', 'ok', 'error', 'cancelled']),
      durationMs: z.number().nonnegative().optional(),
      error: z.string().optional(),
    }),
  ),
});

const slot = {
  callId: ToolCallId,
  name: ToolName,
  status: z.enum(['pending', 'running', 'done']),
  taskId: z.number().int().positive().optional(),
  entry: z.number().int().positive().optional(),
  output: z.string().optional(),
  details: z.json().optional(),
  diagnostics: z.array(NativeDiagnostic).optional(),
};

export const NativeLive = z.object({
  tools: z.array(z.object(slot)).optional(),
  nestedTools: z
    .array(
      z.object({
        ...slot,
        taskId: z.number().int().positive(),
        parentTaskId: z.number().int().positive(),
        parentCallId: ToolCallId,
        arguments: z.record(z.string(), z.json()),
        summary: z.object({ isError: z.boolean(), error: z.string().optional() }).optional(),
      }),
    )
    .optional(),
  generation: z
    .object({
      message: z.object({ role: z.literal('assistant'), content: NativeContent, timestamp: z.number() }).optional(),
    })
    .optional(),
});
