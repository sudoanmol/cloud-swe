import { useCommandState } from "cmdk";
import { useQuery } from "@tanstack/react-query";
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

/** Mount only while open: React Query refreshes each catalog once per opening. */
export function MentionPicker({
  userId,
  thread,
  repository,
  query,
  onInsert,
  onClose,
  onActiveChange,
  ref,
}: {
  userId: string;
  thread?: { id: string; running: boolean };
  repository: RepositorySelection | null | undefined;
  query: string;
  onInsert: (value: string) => void;
  onClose: () => void;
  onActiveChange: (selection: MentionSelection) => void;
  ref: Ref<MentionPickerHandle>;
}) {
  const live = thread?.running === true;

  const files = useQuery({
    ...workspaceFilesQueryOptions(userId, thread?.id ?? ""),
    enabled: live,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const tree = useQuery({
    ...repositoryTreeQueryOptions(userId, repository),
    enabled: !live && !!repository,
  });

  const catalogRepository =
    repository && tree.data?.sha ? { ...repository, branch: tree.data.sha } : repository;

  const skills = useQuery({
    ...mentionsSkillsQueryOptions(userId, thread?.id, thread ? undefined : catalogRepository),
    enabled: !!thread || !repository || !!tree.data,
  });

  const [selected, setSelected] = useState("");
  const paths = live ? files.data?.paths : tree.data?.paths;

  const items = useMemo(
    () =>
      filterMentions(
        [
          ...(paths ?? []).map((path): MentionItem => ({
            value: `@${path}`,
            label: path,
            group: "Files",
          })),
          ...(skills.data?.skills ?? []).map((skill): MentionItem => ({
            value: `$${skill.name}`,
            label: skill.name,
            description: skill.description,
            group: "Skills",
          })),
        ],
        query,
      ),
    [paths, skills.data, query],
  );

  const value = items.some((item) => item.value === selected) ? selected : (items[0]?.value ?? "");
  const listRef = useRef<HTMLDivElement>(null);
  const fileQuery = live ? files : tree;
  const loading = ((live || !!repository) && fileQuery.isFetching) || skills.isFetching;
  const failed = ((live || !!repository) && fileQuery.isError) || skills.isError;

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
        label="Mention files or skills"
        shouldFilter={false}
        value={value}
        onValueChange={setSelected}
      >
        <ActiveMention listRef={listRef} onChange={onActiveChange} />
        <CommandList ref={listRef}>
          <CommandEmpty>
            {loading ? "Loading files and skills…" : "No matching files or skills"}
          </CommandEmpty>
          {(["Files", "Skills"] as const).map((group) => (
            <CommandGroup key={group} heading={group}>
              {items
                .filter((item) => item.group === group)
                .map((item) => (
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
          ))}
        </CommandList>
      </Command>
      {thread && !live ? (
        <p className="px-3 py-1 text-xs text-muted-foreground">
          Local-only files appear once the workspace runs.
        </p>
      ) : null}
      {fileQuery.data?.truncated ? (
        <p className="px-3 py-1 text-xs text-muted-foreground">
          This file list is incomplete. You can still type a file path.
        </p>
      ) : null}
      {failed ? (
        <p role="status" className="px-3 py-1 text-xs text-destructive">
          Could not load all files and skills.{" "}
          <button
            type="button"
            onClick={() => {
              void fileQuery.refetch();
              void skills.refetch();
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
    if (listRef.current)
      onChange({
        listId: listRef.current.id,
        itemId: listRef.current.querySelector('[aria-selected="true"]')?.id,
      });
  }, [value, listRef, onChange]);

  return null;
}
