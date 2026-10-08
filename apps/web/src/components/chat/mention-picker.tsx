import { useCommandState } from "cmdk";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
  type RefObject,
} from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { filterMentions, mentionKey, type MentionItem } from "@/lib/mentions";
import {
  mentionsSkillsQueryOptions,
  repositoryTreeQueryOptions,
  workspaceFilesQueryOptions,
} from "@/lib/queries";
import type { RepositorySelection } from "@/lib/repository-selection";

export type MentionSelection = { listId: string; itemId: string | undefined };

export type MentionPickerHandle = { keyDown: (key: string) => boolean };

type MentionThread = { id: string; running: boolean };

/** Pins the skills lookup to the commit the repository tree resolved to. */
function useSkillsCatalog(
  userId: string,
  thread: MentionThread | undefined,
  repository: RepositorySelection | null | undefined,
  group: MentionItem["group"],
  tree: UseQueryResult<{ sha?: string | null }>,
) {
  const catalogRepository =
    repository && tree.data?.sha ? { ...repository, branch: tree.data.sha } : repository;

  return useQuery({
    ...mentionsSkillsQueryOptions(userId, thread?.id, thread ? undefined : catalogRepository),
    enabled: group === "Skills" && (!!thread || !repository || !!tree.data),
  });
}

/** The catalogs that feed one open picker, and the ones its group is waiting on. */
function useMentionCatalogs(
  userId: string,
  thread: MentionThread | undefined,
  repository: RepositorySelection | null | undefined,
  group: MentionItem["group"],
) {
  const live = thread?.running === true;

  const files = useQuery({
    ...workspaceFilesQueryOptions(userId, thread?.id ?? ""),
    enabled: group === "Files" && live,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const tree = useQuery({
    ...repositoryTreeQueryOptions(userId, repository),
    enabled: !!repository && (group === "Files" ? !live : !thread),
  });

  const skills = useSkillsCatalog(userId, thread, repository, group, tree);

  const fileQuery = live ? files : tree;
  let queries: (typeof fileQuery | typeof skills)[] = [skills];

  if (group === "Files") queries = live || repository ? [fileQuery] : [];
  else if (!thread && repository) queries = [tree, skills];

  return { live, fileQuery, queries, paths: fileQuery.data?.paths, skills: skills.data?.skills };
}

/** Mount only while open: React Query refreshes each catalog once per opening. */
export function MentionPicker({
  userId,
  thread,
  repository,
  query,
  group,
  onInsert,
  onClose,
  onActiveChange,
  ref,
}: {
  userId: string;
  thread?: MentionThread;
  repository: RepositorySelection | null | undefined;
  query: string;
  group: MentionItem["group"];
  onInsert: (value: string) => void;
  onClose: () => void;
  onActiveChange: (selection: MentionSelection) => void;
  ref: Ref<MentionPickerHandle>;
}) {
  const { live, fileQuery, queries, paths, skills } = useMentionCatalogs(
    userId,
    thread,
    repository,
    group,
  );

  const [selected, setSelected] = useState("");

  const items = useMemo(
    () =>
      filterMentions(
        [
          ...(paths ?? []).map((path): MentionItem => ({
            value: `@${path}`,
            label: path,
            group: "Files",
          })),
          ...(skills ?? []).map((skill): MentionItem => ({
            value: `$${skill.name}`,
            label: skill.name,
            description: skill.description,
            group: "Skills",
          })),
        ],
        query,
        group,
      ),
    [paths, skills, query, group],
  );

  const value = items.some((item) => item.value === selected) ? selected : (items[0]?.value ?? "");
  const listRef = useRef<HTMLDivElement>(null);
  const loading = queries.some((catalog) => catalog.isFetching);
  const failed = queries.some((catalog) => catalog.isError);

  useImperativeHandle(ref, () => ({
    keyDown: (key) => {
      const action = mentionKey(key, items, value);

      if (!action) return false;

      if (action.kind === "close") onClose();
      else if (action.kind === "move") setSelected(action.value);
      else if (action.value) onInsert(action.value);

      return true;
    },
  }));

  return (
    <div
      className="absolute bottom-full left-0 mb-2 w-full rounded-xl border bg-popover p-1 shadow-lg"
      onMouseDown={(event) => event.preventDefault()}
    >
      <Command
        label={`Mention ${group.toLowerCase()}`}
        shouldFilter={false}
        value={value}
        onValueChange={setSelected}
      >
        <ActiveMention listRef={listRef} onChange={onActiveChange} />
        <CommandList ref={listRef}>
          <CommandEmpty>
            {loading ? `Loading ${group.toLowerCase()}…` : `No matching ${group.toLowerCase()}`}
          </CommandEmpty>
          <CommandGroup heading={group}>
            {items.map((item) => (
              <CommandItem
                key={item.value}
                value={item.value}
                onSelect={() => onInsert(item.value)}
                className="data-[selected=true]:bg-accent"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate">{item.label}</span>
                  {item.description ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {item.description}
                    </span>
                  ) : null}
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
      {group === "Files" && thread && !live ? (
        <p className="px-3 py-1 text-xs text-muted-foreground">
          Local-only files appear once the workspace runs.
        </p>
      ) : null}
      {group === "Files" && fileQuery.data?.truncated ? (
        <p className="px-3 py-1 text-xs text-muted-foreground">
          This file list is incomplete. You can still type a file path.
        </p>
      ) : null}
      {failed ? (
        <p role="status" className="px-3 py-1 text-xs text-destructive">
          Could not load all {group.toLowerCase()}.{" "}
          <button
            type="button"
            onClick={() => {
              for (const catalog of queries) void catalog.refetch();
            }}
            className="underline"
          >
            Retry
          </button>
        </p>
      ) : null}
    </div>
  );
}

/** cmdk owns its generated IDs; mirror them on the external composer input. */
function ActiveMention({
  listRef,
  onChange,
}: {
  listRef: RefObject<HTMLDivElement | null>;
  onChange: (selection: MentionSelection) => void;
}) {
  const value = useCommandState((state) => state.value);
  useEffect(() => {
    if (listRef.current) {
      const selected = listRef.current.querySelector('[aria-selected="true"]');
      selected?.scrollIntoView({ block: "nearest", inline: "nearest" });
      onChange({
        listId: listRef.current.id,
        itemId: selected?.id,
      });
    }
  }, [value, listRef, onChange]);

  return null;
}
