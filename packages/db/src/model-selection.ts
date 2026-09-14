import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { vercelAIGatewayProvider } from "@earendil-works/pi-ai/providers/vercel-ai-gateway";
import { z } from "zod";

export const modelProviderSchema = z.enum(["vercel-ai-gateway", "openrouter", "openai-codex"]);

export type ModelProvider = z.infer<typeof modelProviderSchema>;

export const modelProviders = [
  vercelAIGatewayProvider(),
  openrouterProvider(),
  openaiCodexProvider(),
];

export const modelSelectionSchema = z
  .object({
    provider: modelProviderSchema,
    model: z.string().min(1).max(255),
    thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
  })
  .strict()
  .superRefine((selection, ctx) => {
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

export type ModelSelection = z.infer<typeof modelSelectionSchema>;

export function modelAcceptsImages(selection: ModelSelection): boolean {
  return Boolean(
    modelProviders
      .find((provider) => provider.id === selection.provider)
      ?.getModels()
      .find((model) => model.id === selection.model)
      ?.input.includes("image"),
  );
}

export function listProviderModels(providerId: ModelProvider) {
  const provider = modelProviders.find((candidate) => candidate.id === providerId);

  return (
    provider?.getModels().map((model) => ({
      id: model.id,
      name: model.name,
      provider: model.provider,
      reasoning: model.reasoning,
      input: model.input,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      cost: model.cost,
      thinkingLevels: getSupportedThinkingLevels(model),
    })) ?? []
  );
}
