import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import {
  modelSelectionSchema,
  type ModelCatalogEntry,
  type ModelProvider,
  type ModelSelection,
} from "@cloud-swe/db/model-contracts";
import { modelProvidersQueryOptions, providerModelsQueryOptions } from "@/lib/queries";
import { toSelection } from "@/components/chat/pickers";

const KEY_PREFIX = "cloud-swe:model-selection";

export function providerIsConnected(
  providers: readonly { id: string; connected: boolean }[],
  selection: Pick<ModelSelection, "provider">,
): boolean {
  return providers.some((provider) => provider.id === selection.provider && provider.connected);
}

export function selectionInCatalog(
  selection: ModelSelection,
  models: readonly Pick<ModelCatalogEntry, "id" | "thinkingLevels">[],
): boolean {
  return models.some(
    (model) =>
      model.id === selection.model && model.thinkingLevels.includes(selection.thinkingLevel),
  );
}

function catalogDefault(
  provider: ModelProvider,
  models: readonly ModelCatalogEntry[],
): ModelSelection | null {
  const first = models[0];

  return first ? toSelection(provider, first) : null;
}

function acceptsImages(
  selection: ModelSelection | null,
  models: readonly ModelCatalogEntry[],
): boolean {
  if (selection === null) return false;

  return models.find((model) => model.id === selection.model)?.input.includes("image") === true;
}

function read(userId: string): ModelSelection | null {
  const raw = window.localStorage.getItem(`${KEY_PREFIX}:${userId}`);

  if (!raw) return null;

  try {
    const parsed = modelSelectionSchema.safeParse(JSON.parse(raw));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Restore this thread's last model before the account preference. Invalid
 * preferences require an explicit replacement, never a provider/model switch. */
export function useModelSelection(userId: string, latestSelection?: ModelSelection | null) {
  const [stored, setStored] = useState<ModelSelection | null>();
  const [chosen, setChosen] = useState<ModelSelection>();
  const providers = useQuery(modelProvidersQueryOptions(userId));
  const candidate = chosen ?? latestSelection ?? stored;

  const provider =
    candidate?.provider ?? providers.data?.providers.find((item) => item.connected)?.id;

  const connected =
    provider !== undefined && providerIsConnected(providers.data?.providers ?? [], { provider });

  const catalog = useQuery({
    ...providerModelsQueryOptions(userId, provider ?? "vercel-ai-gateway"),
    enabled: connected,
  });

  useEffect(() => {
    setChosen(undefined);
    setStored(read(userId));
  }, [userId]);

  const models = catalog.data?.models ?? [];

  // Offer a catalog default only when there is no previous choice to replace.
  const proposed =
    candidate ?? (stored !== undefined && provider ? catalogDefault(provider, models) : null);

  const selection = proposed && connected && selectionInCatalog(proposed, models) ? proposed : null;

  const setSelection = useCallback(
    (next: ModelSelection) => {
      setChosen(next);
      window.localStorage.setItem(`${KEY_PREFIX}:${userId}`, JSON.stringify(next));
    },
    [userId],
  );

  return { selection, setSelection, supportsImages: acceptsImages(selection, models) };
}
