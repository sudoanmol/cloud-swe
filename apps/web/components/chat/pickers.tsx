"use client";

import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import {
  CheckIcon,
  ChevronsUpDownIcon,
  CpuIcon,
  GitBranchIcon,
  GithubIcon,
  LockIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ThreadApiError } from "@cloud-swe/api/client";

import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { cn } from "@/lib/utils";
import {
  branchesQueryOptions,
  installationsQueryOptions,
  modelProvidersQueryOptions,
  providerModelsQueryOptions,
  repositoriesQueryOptions,
} from "@/lib/queries";

const PROVIDERS: ModelProvider[] = ["vercel-ai-gateway", "openrouter", "openai-codex"];

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
      enabled: open && connected.includes(provider),
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
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          className="max-w-64 justify-between gap-2 font-normal"
          disabled={disabled}
          size="sm"
          type="button"
          variant="ghost"
        >
          <CpuIcon className="size-3.5 shrink-0 opacity-70" />
          <span className="truncate">
            {selection
              ? `${selected?.name ?? selection.model} · ${selection.thinkingLevel}`
              : "Select a model"}
          </span>
          <ChevronsUpDownIcon className="size-3.5 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-88 p-0">
        <Command>
          <CommandInput placeholder="Search models" />
          <CommandList>
            <CommandEmpty>
              {providers.isPending || catalogs.some((catalog) => catalog.isFetching)
                ? "Loading models…"
                : connected.length === 0
                  ? "Connect a provider in onboarding."
                  : "No models found."}
            </CommandEmpty>
            {groups.map((group) => (
              <CommandGroup heading={providerLabel(group.provider)} key={group.provider}>
                {group.models.map((model) => (
                  <CommandItem
                    key={`${group.provider}:${model.id}`}
                    onSelect={() => onChange(toSelection(group.provider, model))}
                    value={`${model.name} ${model.id} ${group.provider}`}
                  >
                    {selection?.provider === group.provider && selection.model === model.id ? (
                      <CheckIcon className="size-3.5" />
                    ) : (
                      <span className="size-3.5" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{model.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
        {selection && selected ? (
          <div className="p-2">
            <Levels
              current={selection.thinkingLevel}
              levels={selected.thinkingLevels}
              onSelect={(thinkingLevel) => onChange({ ...selection, thinkingLevel })}
            />
          </div>
        ) : null}
        {providers.isError || failedCatalogs.length > 0 ? (
          <Alert variant="destructive">
            <AlertDescription>
              <p>Some model choices could not be loaded.</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  if (providers.isError) void providers.refetch();

                  for (const index of failedCatalogs) void catalogs[index]?.refetch();
                }}
              >
                Retry models
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** Thinking level is part of the selection; each catalog level is a real choice. */
function Levels({
  levels,
  current,
  onSelect,
}: {
  levels: readonly ThinkingLevel[];
  current: ThinkingLevel | null;
  onSelect: (level: ThinkingLevel) => void;
}) {
  if (levels.length <= 1) return current ? <Badge variant="secondary">{current}</Badge> : null;

  return (
    <Select
      value={current ?? ""}
      onValueChange={(value) => {
        const level = levels.find((candidate) => candidate === value);

        if (level) onSelect(level);
      }}
    >
      <SelectTrigger aria-label="Thinking level">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {levels.map((level) => (
            <SelectItem key={level} value={level}>
              {level}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
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
    case "vercel-ai-gateway":
      return "Vercel AI Gateway";
    case "openrouter":
      return "OpenRouter";
    case "openai-codex":
      return "OpenAI Codex";
  }
}

/** Distinguishes "still loading", "GitHub is not reachable" and "none installed". */
function repositoryEmptyMessage(
  installations: { isPending: boolean; isError: boolean },
  repositories: { isPending: boolean; isError: boolean },
): string {
  if (installations.isError || repositories.isError) return "GitHub could not be reached.";

  if (installations.isPending) return "Loading installations…";

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
 * Page installation-scoped repositories. An empty repository cannot supply the
 * initial checkout; selection always retains its verified default branch.
 */
export function RepositoryPicker({
  userId,
  value,
  onChange,
  disabled,
  autoSelect = false,
}: {
  userId: string;
  value: { url: string; branch: string | null } | null;
  onChange: (value: { url: string; branch: string | null } | null) => void;
  disabled?: boolean;
  /** New threads require a repository, so the first one is selected for you. */
  autoSelect?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [chosenInstallation, setChosenInstallation] = useState<number | null>(null);
  const autoSelected = useRef(false);
  const installations = useInfiniteQuery(installationsQueryOptions(userId));

  const accounts = Array.from(
    new Map(
      (installations.data?.pages.flatMap((page) => page.items) ?? [])
        .filter((item) => !item.suspended)
        .map((item) => [item.id, item]),
    ).values(),
  );

  const installationId = chosenInstallation ?? accounts[0]?.id ?? null;

  const repositories = useInfiniteQuery({
    ...repositoriesQueryOptions(userId, installationId ?? 0),
    enabled: installationId !== null,
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

  useEffect(() => {
    if (!autoSelect || autoSelected.current || value !== null) return;
    const first = choices.find((choice) => !choice.empty);

    if (!first) return;
    autoSelected.current = true;
    onChange({ branch: first.defaultBranch, url: first.url });
  }, [autoSelect, choices, onChange, value]);

  useEffect(() => {
    if (!value) return;

    const denied =
      repositories.error instanceof ThreadApiError &&
      [403, 404].includes(repositories.error.status);

    const missing =
      repositories.isSuccess &&
      !repositories.hasNextPage &&
      !choices.some((choice) => choice.url === value.url && !choice.empty);

    if (denied || missing) onChange(null);
  }, [
    choices,
    onChange,
    repositories.error,
    repositories.hasNextPage,
    repositories.isSuccess,
    value,
  ]);

  return (
    <div className="flex w-full min-w-0 items-center justify-between gap-2">
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <Button
            className="min-w-0 max-w-52 shrink justify-between gap-2 font-normal"
            disabled={disabled}
            size="sm"
            type="button"
            variant="ghost"
          >
            <GithubIcon className="size-3.5 shrink-0 opacity-70" />
            <span className="truncate">
              {value ? value.url.replace(/^https:\/\/github\.com\//, "") : "No repository"}
            </span>
            <ChevronsUpDownIcon className="size-3.5 shrink-0 opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="flex max-h-[var(--radix-popover-content-available-height)] w-96 max-w-[calc(100vw-2rem)] flex-col p-0"
        >
          <div className="flex shrink-0 flex-col gap-2 p-2">
            <Select
              value={installationId === null ? "" : String(installationId)}
              onValueChange={(value) => {
                const account = accounts.find((item) => String(item.id) === value);

                if (!account) return;
                autoSelected.current = false;
                setChosenInstallation(account.id);
                onChange(null);
              }}
            >
              <SelectTrigger aria-label="GitHub installation">
                <SelectValue placeholder="Select account" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {accounts.map((account) => (
                    <SelectItem key={account.id} value={String(account.id)}>
                      {account.accountLogin}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {installations.hasNextPage ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={installations.isFetchingNextPage}
                onClick={() => void installations.fetchNextPage()}
              >
                Load more accounts
              </Button>
            ) : null}
            {installations.isError ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void installations.refetch()}
              >
                Retry accounts
              </Button>
            ) : null}
          </div>
          <Command className="h-auto min-h-0 flex-1">
            <CommandInput placeholder="Search repositories" />
            <CommandList className="min-h-0 overflow-y-auto">
              <CommandEmpty>{repositoryEmptyMessage(installations, repositories)}</CommandEmpty>
              <CommandGroup heading="Repositories">
                {autoSelect ? null : (
                  <CommandItem
                    onSelect={() => {
                      onChange(null);
                      setOpen(false);
                    }}
                  >
                    <span className="size-3.5" />
                    <span className="truncate">No repository (empty workspace)</span>
                  </CommandItem>
                )}
                {choices.map((choice) => (
                  <CommandItem
                    key={choice.url}
                    disabled={choice.empty}
                    onSelect={() => {
                      autoSelected.current = true;
                      onChange({ url: choice.url, branch: choice.defaultBranch });
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
        </PopoverContent>
      </Popover>
      {value ? (
        <BranchPicker
          key={value.url}
          disabled={disabled}
          branch={value.branch}
          defaultBranch={choices.find((choice) => choice.url === value.url)?.defaultBranch ?? null}
          onSelect={(branch) => onChange({ url: value.url, branch })}
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
          className="min-w-0 max-w-40 shrink gap-1.5 font-normal"
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
        className="flex max-h-[var(--radix-popover-content-available-height)] w-72 flex-col p-0"
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
