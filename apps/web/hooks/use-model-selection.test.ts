import { expect, test } from "bun:test";

import { providerIsConnected, selectionInCatalog } from "./use-model-selection";
import type { ModelSelection } from "@cloud-swe/db/model-contracts";

test("a restored model requires both catalog membership and its selected thinking level", () => {
  const selection: ModelSelection = {
    provider: "openrouter",
    model: "chosen",
    thinkingLevel: "high",
  };

  expect(selectionInCatalog(selection, [{ id: "chosen", thinkingLevels: ["off", "high"] }])).toBe(
    true,
  );
  expect(selectionInCatalog(selection, [{ id: "replacement", thinkingLevels: ["high"] }])).toBe(
    false,
  );
  expect(selectionInCatalog(selection, [{ id: "chosen", thinkingLevels: ["off"] }])).toBe(false);
  expect(selectionInCatalog(selection, [])).toBe(false);
});

test("a stored selection survives only while its provider is connected", () => {
  const providers = [
    { connected: true, id: "vercel-ai-gateway" },
    { connected: false, id: "openrouter" },
  ];

  expect(providerIsConnected(providers, { provider: "vercel-ai-gateway" })).toBe(true);
  expect(providerIsConnected(providers, { provider: "openrouter" })).toBe(false);
  expect(providerIsConnected(providers, { provider: "openai-codex" })).toBe(false);
  expect(providerIsConnected([], { provider: "vercel-ai-gateway" })).toBe(false);
});
