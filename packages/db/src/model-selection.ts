import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { vercelAIGatewayProvider } from "@earendil-works/pi-ai/providers/vercel-ai-gateway";

import {
  modelProviderSchema,
  modelSelectionSchema as structuralModelSelectionSchema,
  modelCatalogEntrySchema,
  thinkingLevelSchema,
  type ModelCatalogEntry,
  type ModelProvider,
  type ModelSelection,
  type ThinkingLevel,
} from "./model-contracts";

export {
  modelProviderSchema,
  thinkingLevelSchema,
  modelCatalogEntrySchema,
  type ModelCatalogEntry,
  type ModelProvider,
  type ModelSelection,
  type ThinkingLevel,
};

export const modelProviders = [
  vercelAIGatewayProvider(),
  openrouterProvider(),
  openaiProvider(),
  anthropicProvider(),
  deepseekProvider(),
  openaiCodexProvider(),
];

/**
 * Server-side selection validation. Unlike the structural browser contract,
 * this checks the pinned Pi catalog and the model's supported thinking levels.
 */
export const modelSelectionSchema = structuralModelSelectionSchema.superRefine((selection, ctx) => {
  const model = modelProviders
    .find((provider) => provider.id === selection.provider)
    ?.getModels()
    .find((candidate) => candidate.id === selection.model);

  if (!model) ctx.addIssue({ code: "custom", path: ["model"], message: "Unsupported model" });
  else if (!getSupportedThinkingLevels(model).includes(selection.thinkingLevel))
    ctx.addIssue({
      code: "custom",
      path: ["thinkingLevel"],
      message: "Unsupported thinking level",
    });
});

export function modelAcceptsImages(selection: ModelSelection): boolean {
  return Boolean(
    modelProviders
      .find((provider) => provider.id === selection.provider)
      ?.getModels()
      .find((model) => model.id === selection.model)
      ?.input.includes("image"),
  );
}

export function listProviderModels(providerId: ModelProvider): ModelCatalogEntry[] {
  const provider = modelProviders.find((candidate) => candidate.id === providerId);

  return (
    provider?.getModels().map((model) =>
      modelCatalogEntrySchema.parse({
        id: model.id,
        name: model.name,
        provider: model.provider,
        reasoning: model.reasoning,
        input: model.input,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        cost: model.cost,
        // Report only levels submission accepts; the catalog may also list
        // provider-specific extras that the selection contract does not expose.
        thinkingLevels: getSupportedThinkingLevels(model).filter(
          (level): level is ThinkingLevel => thinkingLevelSchema.safeParse(level).success,
        ),
      }),
    ) ?? []
  );
}
