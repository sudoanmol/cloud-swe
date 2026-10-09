import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import {
  BrainIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  EyeIcon,
  GitBranchIcon,
  GithubIcon,
  LockIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type {
  ModelCatalogEntry,
  ModelProvider,
  ModelSelection,
  ThinkingLevel,
} from "@cloud-swe/db/model-contracts";
import {
  readRepositorySelection,
  writeRepositorySelection,
  type RepositorySelection,
} from "@/lib/repository-selection";
import { cn } from "@/lib/utils";
import {
  branchesQueryOptions,
  installationsQueryOptions,
  modelProvidersQueryOptions,
  providerModelsQueryOptions,
  repositoriesQueryOptions,
} from "@/lib/queries";

const PROVIDERS: ModelProvider[] = [
  "vercel-ai-gateway",
  "openrouter",
  "openai",
  "anthropic",
  "deepseek",
  "openai-codex",
];

/** Catalog id prefixes whose models.dev logo slug differs. */
const LOGO_ALIASES = new Map([
  ["meta-llama", "llama"],
  ["mistralai", "mistral"],
  ["qwen", "alibaba"],
  ["x-ai", "xai"],
  ["z-ai", "zai"],
]);

function logoProvider(provider: ModelProvider, modelId: string): string {
  const [prefix] = modelId.split("/");

  if (prefix && prefix !== modelId) return LOGO_ALIASES.get(prefix) ?? prefix;

  switch (provider) {
    case "anthropic":
      return "anthropic";
    case "openai":
    case "openai-codex":
      return "openai";
    case "openrouter":
      return "openrouter";
    case "deepseek":
      return "deepseek";
    case "vercel-ai-gateway":
      return "vercel";
  }
}

function optionValue(provider: ModelProvider, modelId: string): string {
  return `${provider}:${modelId}`;
}

/**
 * Model and thinking level both come from the server catalog: the picker never
 * offers a model or a level that submission would reject.
 */
export function ModelPicker({
  userId,
  selection,
  onChange,
  disabled,
}: {
  userId: string;
  selection: ModelSelection | null;
  onChange: (selection: ModelSelection) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const providers = useQuery(modelProvidersQueryOptions(userId));

  const connected = useMemo(
    () =>
      (providers.data?.providers ?? []).flatMap((provider) =>
        provider.connected ? [provider.id] : [],
      ),
    [providers.data],
  );

  const catalogs = useQueries({
    queries: PROVIDERS.map((provider) => ({
      ...providerModelsQueryOptions(userId, provider),
      // The selected provider's catalog names the trigger and its thinking levels.
      enabled: connected.includes(provider) && (open || selection?.provider === provider),
    })),
  });

  const failedCatalogs = PROVIDERS.flatMap((provider, index) =>
    connected.includes(provider) && catalogs[index]?.isError ? [index] : [],
  );

  const models = catalogs.flatMap((catalog) => catalog.data?.models ?? []);
  const selected = selection ? models.find((model) => matches(selection, model)) : undefined;

  const groups = useMemo(
    () =>
      PROVIDERS.flatMap((provider, index) =>
        connected.includes(provider)
          ? [{ models: catalogs[index]?.data?.models ?? [], provider }]
          : [],
      ),
    [catalogs, connected],
  );

  return (
    <>
      <ModelSelector onOpenChange={setOpen} open={open}>
        <ModelSelectorTrigger asChild>
          <Button
            className="h-7 max-w-[200px] justify-between gap-1.5 rounded-lg px-2 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            data-testid="model-selector"
            disabled={disabled}
            type="button"
            variant="ghost"
          >
            {selection ? (
              <ModelSelectorLogo provider={logoProvider(selection.provider, selection.model)} />
            ) : null}
            <ModelSelectorName>
              {selection ? (selected?.name ?? selection.model) : "Select a model"}
            </ModelSelectorName>
          </Button>
        </ModelSelectorTrigger>
        <ModelSelectorContent
          commandDefaultValue={
            selection ? optionValue(selection.provider, selection.model) : undefined
          }
        >
          <ModelSelectorInput placeholder="Search models..." />
          <ModelSelectorList>
            <ModelSelectorEmpty>
              {providers.isPending || catalogs.some((catalog) => catalog.isFetching)
                ? "Loading models…"
                : connected.length === 0
                  ? "Connect a provider in onboarding."
                  : "No models found."}
            </ModelSelectorEmpty>
            {groups.map((group) => (
              <ModelSelectorGroup heading={providerLabel(group.provider)} key={group.provider}>
                {group.models.map((model) => (
                  <ModelSelectorItem
                    className={cn(
                      "flex w-full transition-colors data-[selected=true]:bg-muted data-[selected=true]:text-foreground",
                      selection?.provider === group.provider &&
                        selection.model === model.id &&
                        "bg-muted font-medium text-foreground",
                    )}
                    key={`${group.provider}:${model.id}`}
                    keywords={[model.name, model.id]}
                    onSelect={() => {
                      onChange(toSelection(group.provider, model));
                      setOpen(false);
                    }}
                    value={optionValue(group.provider, model.id)}
                  >
                    <ModelSelectorLogo provider={logoProvider(group.provider, model.id)} />
                    <ModelSelectorName>{model.name}</ModelSelectorName>
                    <div className="ml-auto flex items-center gap-2 text-foreground/70">
                      {model.input.includes("image") ? (
                        <CapabilityIcon label="Supports vision">
                          <EyeIcon className="size-3.5" />
                        </CapabilityIcon>
                      ) : null}
                      {model.reasoning ? (
                        <CapabilityIcon label="Supports reasoning">
                          <BrainIcon className="size-3.5" />
                        </CapabilityIcon>
                      ) : null}
                    </div>
                  </ModelSelectorItem>
                ))}
              </ModelSelectorGroup>
            ))}
          </ModelSelectorList>
          {providers.isError || failedCatalogs.length > 0 ? (
            <div className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-2 text-[12px] text-destructive">
              <span>Some models could not be loaded.</span>
              <Button
                className="h-6 px-2 text-[12px]"
                onClick={() => {
                  if (providers.isError) void providers.refetch();

                  for (const index of failedCatalogs) void catalogs[index]?.refetch();
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                Retry models
              </Button>
            </div>
          ) : null}
        </ModelSelectorContent>
      </ModelSelector>
      {selection && selected ? (
        <ThinkingPicker
          current={selection.thinkingLevel}
          disabled={disabled}
          levels={selected.thinkingLevels}
          onSelect={(thinkingLevel) => onChange({ ...selection, thinkingLevel })}
        />
      ) : null}
    </>
  );
}

function CapabilityIcon({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span aria-label={label} className="inline-flex" role="img">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/** Thinking level is part of the selection; each catalog level is a real choice. */
function ThinkingPicker({
  levels,
  current,
  onSelect,
  disabled,
}: {
  levels: readonly ThinkingLevel[];
  current: ThinkingLevel | null;
  onSelect: (level: ThinkingLevel) => void;
  disabled?: boolean;
}) {
  if (levels.length <= 1) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Thinking level"
          className="h-7 gap-1.5 rounded-lg px-2 text-[12px] text-muted-foreground capitalize transition-colors hover:text-foreground"
          disabled={disabled}
          type="button"
          variant="ghost"
        >
          <BrainIcon className="size-3.5" />
          {current ?? "Thinking"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="rounded-xl border border-border/60 bg-card/95 shadow-[var(--shadow-float)] backdrop-blur-xl"
        side="top"
        sideOffset={8}
      >
        <DropdownMenuRadioGroup
          onValueChange={(value) => {
            const level = levels.find((candidate) => candidate === value);

            if (level) onSelect(level);
          }}
          value={current ?? ""}
        >
          {levels.map((level) => (
            <DropdownMenuRadioItem className="text-[13px] capitalize" key={level} value={level}>
              {level}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function matches(selection: ModelSelection, model: ModelCatalogEntry): boolean {
  return selection.provider === model.provider && selection.model === model.id;
}

export function toSelection(provider: ModelProvider, model: ModelCatalogEntry): ModelSelection {
  const preferred =
    model.thinkingLevels.find((level) => level === "medium") ?? model.thinkingLevels[0] ?? "off";

  return { provider, model: model.id, thinkingLevel: preferred };
}

function providerLabel(provider: ModelProvider): string {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "vercel-ai-gateway":
      return "Vercel AI Gateway";
    case "openrouter":
      return "OpenRouter";
    case "deepseek":
      return "DeepSeek";
    case "openai-codex":
      return "OpenAI Codex";
  }
}

/** Distinguishes "still loading", "GitHub is not reachable" and "none installed". */
function repositoryEmptyMessage(
  installations: { isPending: boolean; isError: boolean; count: number },
  repositories: { isPending: boolean; isError: boolean },
): string {
  if (installations.isError || repositories.isError) return "GitHub could not be reached.";

  if (installations.isPending) return "Loading installations…";

  if (installations.count === 0) return "No repositories available.";

  if (repositories.isPending) return "Loading repositories…";

  return "No repositories available.";
}

type RepositoryChoice = {
  url: string;
  owner: string;
  name: string;
  label: string;
  private: boolean;
  defaultBranch: string | null;
  empty: boolean;
};

/**
 * Page repositories across the user's GitHub App installations. An empty
 * repository cannot supply the initial checkout. `undefined` means the choice
 * is still resolving: the picker restores the last repository and branch when
 * still available, otherwise the first usable repository.
 */
export function RepositoryPicker({
  userId,
  value,
  onChange,
  disabled,
}: {
  userId: string;
  value: RepositorySelection | null | undefined;
  onChange: (value: RepositorySelection | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const installations = useInfiniteQuery(installationsQueryOptions(userId));

  const accounts = Array.from(
    new Map(
      (installations.data?.pages.flatMap((page) => page.items) ?? [])
        .filter((item) => !item.suspended)
        .map((item) => [item.id, item]),
    ).values(),
  );

  useEffect(() => {
    if (
      installations.hasNextPage &&
      !installations.isFetchingNextPage &&
      !installations.isFetchNextPageError
    )
      void installations.fetchNextPage();
  }, [
    installations.hasNextPage,
    installations.isFetchingNextPage,
    installations.isFetchNextPageError,
    installations.fetchNextPage,
  ]);

  const installationIds = accounts.map((account) => account.id);

  const repositories = useInfiniteQuery({
    ...repositoriesQueryOptions(userId, installationIds),
    enabled: installationIds.length > 0 && !installations.hasNextPage,
  });

  const choices = useMemo<RepositoryChoice[]>(
    () =>
      Array.from(
        new Map(
          (repositories.data?.pages.flatMap((page) => page.items) ?? []).map((repository) => [
            repository.fullName,
            repository,
          ]),
        ).values(),
      ).map((repository) => ({
        url: `https://github.com/${repository.fullName}`,
        owner: repository.owner,
        name: repository.name,
        label: repository.fullName,
        private: repository.private,
        defaultBranch: repository.defaultBranch,
        empty: repository.empty === true || repository.defaultBranch === null,
      })),
    [repositories.data],
  );

  const discoveryDone =
    installations.isSuccess &&
    !installations.hasNextPage &&
    (installationIds.length === 0 || repositories.isSuccess);

  const failed = installations.isError || repositories.isError;

  useEffect(() => {
    if (value !== undefined) return;

    if (failed) {
      onChange(null);

      return;
    }

    const remembered = readRepositorySelection(userId);
    const restored = choices.find((choice) => choice.url === remembered?.url && !choice.empty);

    if (remembered && restored) {
      onChange({ url: restored.url, branch: remembered.branch });

      return;
    }

    if (!discoveryDone) return;

    const first = choices.find((choice) => !choice.empty);
    onChange(first ? { url: first.url, branch: first.defaultBranch } : null);
  }, [choices, discoveryDone, failed, onChange, userId, value]);

  const select = (next: RepositorySelection) => {
    writeRepositorySelection(userId, next);
    onChange(next);
  };

  useEffect(() => {
    if (!value) return;

    const missing =
      repositories.isSuccess &&
      !repositories.hasNextPage &&
      !installations.hasNextPage &&
      !choices.some((choice) => choice.url === value.url && !choice.empty);

    if (missing) onChange(null);
  }, [
    choices,
    onChange,
    repositories.hasNextPage,
    repositories.isSuccess,
    installations.hasNextPage,
    value,
  ]);

  return (
    <div className="flex w-full min-w-0 items-center justify-between gap-2">
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <Button
            className="h-7 min-w-0 max-w-52 shrink justify-between gap-1.5 rounded-lg px-2 text-[12px] font-normal text-muted-foreground transition-colors hover:text-foreground"
            disabled={disabled}
            size="sm"
            type="button"
            variant="ghost"
          >
            <GithubIcon className="size-3.5 shrink-0 opacity-70" />
            <span className="truncate">
              {value
                ? value.url.replace(/^https:\/\/github\.com\//, "")
                : value === undefined
                  ? "Loading repositories…"
                  : "No repository"}
            </span>
            <ChevronsUpDownIcon className="size-3.5 shrink-0 opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="flex max-h-[var(--radix-popover-content-available-height)] w-96 max-w-[calc(100vw-2rem)] flex-col rounded-xl border border-border/60 bg-card/95 p-0 shadow-[var(--shadow-float)] backdrop-blur-xl"
        >
          <Command className="h-auto min-h-0 flex-1">
            <CommandInput placeholder="Search repositories" />
            <CommandList className="min-h-0 overflow-y-auto">
              <CommandEmpty>
                {repositoryEmptyMessage(
                  {
                    isPending: installations.isPending,
                    isError: installations.isError,
                    count: installationIds.length,
                  },
                  repositories,
                )}
              </CommandEmpty>
              <CommandGroup heading="Repositories">
                {choices.map((choice) => (
                  <CommandItem
                    key={choice.url}
                    disabled={choice.empty}
                    onSelect={() => {
                      select({ url: choice.url, branch: choice.defaultBranch });
                      setOpen(false);
                    }}
                    value={`${choice.label} ${choice.url}`}
                  >
                    {choice.url === value?.url ? (
                      <CheckIcon className="size-3.5" />
                    ) : (
                      <span className="size-3.5" />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {choice.label}
                      {choice.empty ? " (empty repository)" : ""}
                    </span>
                    {choice.private ? <LockIcon className="size-3 shrink-0 opacity-60" /> : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
          {repositories.hasNextPage ? (
            <Button
              type="button"
              variant="ghost"
              className="w-full shrink-0"
              disabled={repositories.isFetchingNextPage}
              onClick={() => void repositories.fetchNextPage()}
            >
              Load more repositories
            </Button>
          ) : null}
          {repositories.isError ? (
            <Button
              type="button"
              variant="outline"
              className="w-full shrink-0"
              onClick={() => void repositories.refetch()}
            >
              Retry repositories
            </Button>
          ) : null}
          {installations.isError ? (
            <Button
              type="button"
              variant="outline"
              className="w-full shrink-0"
              onClick={() => void installations.refetch()}
            >
              Retry GitHub access
            </Button>
          ) : null}
        </PopoverContent>
      </Popover>
      {value ? (
        <BranchPicker
          key={value.url}
          disabled={disabled}
          branch={value.branch}
          defaultBranch={choices.find((choice) => choice.url === value.url)?.defaultBranch ?? null}
          onSelect={(branch) => select({ url: value.url, branch })}
          owner={choices.find((choice) => choice.url === value.url)?.owner ?? ""}
          repo={choices.find((choice) => choice.url === value.url)?.name ?? ""}
          userId={userId}
        />
      ) : null}
    </div>
  );
}

function BranchPicker({
  userId,
  owner,
  repo,
  branch,
  defaultBranch,
  onSelect,
  disabled,
}: {
  userId: string;
  owner: string;
  repo: string;
  branch: string | null;
  defaultBranch: string | null;
  onSelect: (branch: string | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const branches = useInfiniteQuery({
    ...branchesQueryOptions(userId, owner, repo),
    enabled: open && repo !== "",
  });

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          className="h-7 min-w-0 max-w-40 shrink gap-1.5 rounded-lg px-2 text-[12px] font-normal text-muted-foreground transition-colors hover:text-foreground"
          disabled={disabled || repo === ""}
          title={`Initial branch: ${branch ?? defaultBranch ?? "unavailable"}`}
          size="sm"
          type="button"
          variant="ghost"
        >
          <GitBranchIcon className="size-3.5 shrink-0 opacity-70" />
          <span className="truncate">{branch ?? defaultBranch ?? "default"}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex max-h-[var(--radix-popover-content-available-height)] w-72 flex-col rounded-xl border border-border/60 bg-card/95 p-0 shadow-[var(--shadow-float)] backdrop-blur-xl"
      >
        <Command className="h-auto min-h-0 flex-1">
          <CommandInput placeholder="Search branches" />
          <CommandList className="min-h-0 flex-1">
            <CommandEmpty>
              {branches.isError
                ? "Branches could not be loaded."
                : branches.isPending
                  ? "Loading branches…"
                  : "No branches found."}
            </CommandEmpty>
            <CommandGroup heading={`${owner}/${repo}`}>
              <CommandItem
                onSelect={() => {
                  onSelect(defaultBranch);
                  setOpen(false);
                }}
              >
                <span className={cn("truncate", branch === null && "font-medium")}>
                  Default{defaultBranch ? ` (${defaultBranch})` : ""}
                </span>
              </CommandItem>
              {Array.from(
                new Map(
                  (branches.data?.pages.flatMap((page) => page.items) ?? []).map((candidate) => [
                    candidate.name,
                    candidate,
                  ]),
                ).values(),
              ).map((candidate) => (
                <CommandItem
                  key={candidate.name}
                  onSelect={() => {
                    onSelect(candidate.name);
                    setOpen(false);
                  }}
                  value={candidate.name}
                >
                  <span className={cn("truncate", candidate.name === branch && "font-medium")}>
                    {candidate.name}
                  </span>
                  {candidate.name === defaultBranch ? (
                    <Badge className="shrink-0" variant="outline">
                      default
                    </Badge>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        {branches.hasNextPage ? (
          <Button
            type="button"
            variant="ghost"
            className="w-full shrink-0"
            disabled={branches.isFetchingNextPage}
            onClick={() => void branches.fetchNextPage()}
          >
            Load more branches
          </Button>
        ) : null}
        {branches.isError ? (
          <Button
            type="button"
            variant="outline"
            className="w-full shrink-0"
            onClick={() => void branches.refetch()}
          >
            Retry branches
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
