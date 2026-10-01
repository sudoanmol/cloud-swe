import { z } from "zod";

/**
 * Structural provider/model/thinking contracts that are safe to import from
 * browser code. Catalog membership and thinking-level support are validated
 * server-side in `model-selection.ts`, which owns the pinned Pi catalog.
 */
export const modelProviderSchema = z.enum([
  "vercel-ai-gateway",
  "openrouter",
  "deepseek",
  "openai-codex",
]);

export type ModelProvider = z.infer<typeof modelProviderSchema>;

export const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);

export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;

export const modelSelectionSchema = z
  .object({
    provider: modelProviderSchema,
    model: z.string().min(1).max(255),
    thinkingLevel: thinkingLevelSchema,
  })
  .strict();

export type ModelSelection = z.infer<typeof modelSelectionSchema>;

export const modelCatalogEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: z.string().min(1),
  reasoning: z.boolean(),
  input: z.array(z.enum(["text", "image"])),
  contextWindow: z.number(),
  maxTokens: z.number(),
  cost: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
  }),
  thinkingLevels: z.array(thinkingLevelSchema),
});

export type ModelCatalogEntry = z.infer<typeof modelCatalogEntrySchema>;
