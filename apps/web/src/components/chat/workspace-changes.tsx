import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { GitStatusEntry } from "@pierre/trees";
import { CheckIcon, ChevronDownIcon, ListTreeIcon } from "lucide-react";

import type { ReviewFile, ReviewSummary } from "@cloud-swe/db/workspace-review";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { workspaceDiffQueryOptions, type DiffView } from "@/lib/queries";
import { messageForError } from "@/lib/submission-errors";
import { cn } from "@/lib/utils";
import { codeTheme } from "./tool-patch";
import { PathTree } from "./path-tree";

function viewLabel(view: DiffView, summary: ReviewSummary | undefined) {
  if (view.mode === "uncommitted") return "Uncommitted changes";

  if (view.mode === "commit") {
    const commit = summary?.commits.find((item) => item.sha === view.sha);

    return commit ? `${commit.shortSha} ${commit.subject}` : view.sha.slice(0, 7);
  }

  return `${summary?.base ?? "HEAD"} → working tree`;
}

function gitStatus(file: ReviewFile, parsed: FileDiffMetadata | undefined): GitStatusEntry {
  if (file.oldPath) return { path: file.path, status: "renamed" };

  if (parsed?.type === "new") return { path: file.path, status: "added" };

  if (parsed?.type === "deleted") return { path: file.path, status: "deleted" };

  return { path: file.path, status: "modified" };
}

function ScopeMenu({
  view,
  summary,
  onChange,
}: {
  view: DiffView;
  summary: ReviewSummary | undefined;
  onChange: (view: DiffView) => void;
}) {
  const commits = summary?.commits ?? [];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="min-w-0 gap-1.5 font-normal" size="sm" variant="secondary">
          <span className="truncate">{viewLabel(view, summary)}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuItem onSelect={() => onChange({ mode: "all" })}>
          All changes
          <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            {view.mode === "all" ? <CheckIcon className="size-3.5 text-primary" /> : null}
            {summary?.base ? `vs ${summary.base}` : null}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onChange({ mode: "uncommitted" })}>
          Uncommitted changes
          {view.mode === "uncommitted" ? (
            <CheckIcon className="ml-auto size-3.5 text-primary" />
          ) : null}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={commits.length === 0}>
            <span className="flex-1">Commits</span>
            <span className="text-xs text-muted-foreground">
              {commits.length}
              {summary?.commitsTruncated ? "+" : ""}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-96 p-0">
            <Command>
              <CommandInput placeholder="Search commits" />
              <CommandList>
                <CommandEmpty>No commits found.</CommandEmpty>
                {commits.map((commit) => (
                  <CommandItem
                    key={commit.sha}
                    onSelect={() => onChange({ mode: "commit", sha: commit.sha })}
                    value={`${commit.subject} ${commit.sha}`}
                  >
                    <span className="truncate">{commit.subject}</span>
                    <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
                      {commit.shortSha}
                    </span>
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function WorkspaceChanges({
  userId,
  threadId,
  summary,
  live,
}: {
  userId: string;
  threadId: string;
  summary: ReviewSummary | undefined;
  /** False while the workspace is paused: cached results stay visible. */
  live: boolean;
}) {
  const [view, setView] = useState<DiffView>({ mode: "all" });
  const [showTree, setShowTree] = useState(true);
  const diff = useQuery({ ...workspaceDiffQueryOptions(userId, threadId, view), enabled: live });
  const diffRefs = useRef(new Map<string, HTMLElement>());

  // Non-throwing mode skips a malformed patch instead of failing the panel.
  const parsed = useMemo(
    () => parsePatchFiles(diff.data?.patch ?? "", undefined, false).flatMap((patch) => patch.files),
    [diff.data?.patch],
  );

  const tree = useMemo(() => {
    const files = diff.data?.files ?? [];
    const byName = new Map(parsed.map((file) => [file.name, file]));

    return {
      paths: files.map((file) => file.path),
      counts: new Map(files.map((file) => [file.path, file])),
      status: files.map((file) => gitStatus(file, byName.get(file.path))),
    };
  }, [diff.data?.files, parsed]);

  const renderedPaths = new Set(parsed.map((file) => file.name));

  const missing = (diff.data?.files ?? []).filter(
    (file) => !file.binary && !renderedPaths.has(file.path),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
        <Button
          aria-label="Toggle file tree"
          aria-pressed={showTree}
          className={cn(showTree && "bg-accent")}
          onClick={() => setShowTree((value) => !value)}
          size="icon-sm"
          variant="ghost"
        >
          <ListTreeIcon className="size-4" />
        </Button>
        <ScopeMenu onChange={setView} summary={summary} view={view} />
        {diff.isFetching ? <Spinner className="ml-auto size-3.5" /> : null}
      </div>

      {diff.isError ? (
        <p className="p-4 text-sm text-destructive">{messageForError(diff.error)}</p>
      ) : diff.isPending ? (
        <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Spinner className="size-3.5" /> Loading changes
        </p>
      ) : diff.data === null ? (
        <p className="p-4 text-sm text-muted-foreground">The workspace is not a Git repository.</p>
      ) : diff.data.files.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">No changes.</p>
      ) : (
        <div className="flex min-h-0 flex-1">
          {showTree ? (
            <div className="w-56 shrink-0 border-r border-border/60">
              <PathTree
                counts={tree.counts}
                gitStatus={tree.status}
                initialExpansion="open"
                onSelectFile={(path) =>
                  diffRefs.current.get(path)?.scrollIntoView({ block: "start" })
                }
                paths={tree.paths}
              />
            </div>
          ) : null}
          <div className="min-w-0 flex-1 overflow-auto">
            {parsed.map((file) => (
              <div
                className="border-b border-border/60"
                key={`${file.prevName ?? ""}:${file.name}`}
                ref={(node) => {
                  if (node) diffRefs.current.set(file.name, node);
                  else diffRefs.current.delete(file.name);
                }}
              >
                <FileDiff
                  fileDiff={file}
                  options={{
                    diffStyle: "unified",
                    overflow: "scroll",
                    stickyHeader: true,
                    theme: codeTheme,
                  }}
                />
              </div>
            ))}
            {diff.data.patchTruncated || missing.length > 0 ? (
              <p className="p-4 text-xs text-muted-foreground">
                {missing.length} more {missing.length === 1 ? "file is" : "files are"} too large to
                show here.
              </p>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
