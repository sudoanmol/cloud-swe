import { PullRequestIcon } from "./pull-request-status";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRightIcon, LoaderIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { Link, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import { type ThreadAction, ThreadActionDialog } from "@/components/chat/thread-dialogs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import type { ThreadSummary } from "@cloud-swe/api/contracts";
import { threadQueryOptions, threadsQueryOptions } from "@/lib/queries";

const PAGE_SIZE = 5;

const SKELETON_WIDTHS = [44, 32, 28, 64, 52];

const HEADING_CLASS =
  "text-[10px] font-semibold uppercase tracking-[0.12em] text-sidebar-foreground/70";

/**
 * Thread history from the paginated backend list. The opaque cursor is passed
 * back untouched. Threads arrive by latest user message or run end and are grouped
 * by repository, five at a time per group.
 */
export function SidebarHistory({ userId }: { userId: string }) {
  const activeId = useParams({ strict: false }).id;
  const { setOpenMobile } = useSidebar();

  const history = useInfiniteQuery({
    ...threadsQueryOptions(userId),
    // Active runs and freshly created threads awaiting their generated title go
    // stale on their own; poll only while such a row is on screen. Title
    // requests time out after 10 seconds, so an older untitled thread stays so.
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.threads.some(
          (thread) =>
            thread.runStatus === "queued" ||
            thread.runStatus === "running" ||
            (thread.title === null && Date.now() - Date.parse(thread.createdAt) < 30_000),
        ),
      )
        ? 5_000
        : false,
  });

  // A thread that moved up between page reads appears twice; keep the newer, first copy.
  const seen = new Set<string>();

  const threads = (history.data?.pages.flatMap((page) => page.threads) ?? []).filter(
    (thread) => !seen.has(thread.id) && Boolean(seen.add(thread.id)),
  );

  const groups = groupThreads(threads);
  const [visibleByRepo, setVisibleByRepo] = useState<Record<string, number>>({});
  const [action, setAction] = useState<ThreadAction | null>(null);

  const closeMobile = useCallback(() => {
    setOpenMobile(false);
  }, [setOpenMobile]);

  const { fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError } = history;
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = sentinel.current;

    // A failed page must not re-trigger on every re-render while still in view.
    if (!element || !hasNextPage || isFetchNextPageError) return;

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage)
        void fetchNextPage();
    });

    observer.observe(element);

    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError]);

  if (history.isPending)
    return (
      <SidebarGroup className="pt-0 group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel className={HEADING_CLASS}>History</SidebarGroupLabel>
        <SidebarGroupContent>
          <div className="flex flex-col gap-0.5 px-1">
            {SKELETON_WIDTHS.map((width) => (
              <div className="flex h-8 items-center gap-2 rounded-lg px-2" key={width}>
                <div
                  className="h-3 flex-1 animate-pulse rounded-md bg-sidebar-foreground/[0.06]"
                  style={{ maxWidth: `${width}%` }}
                />
              </div>
            ))}
          </div>
        </SidebarGroupContent>
      </SidebarGroup>
    );

  if (threads.length === 0)
    return (
      <SidebarGroup className="pt-0 group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel className={HEADING_CLASS}>History</SidebarGroupLabel>
        <SidebarGroupContent>
          <div className="flex w-full flex-row items-center justify-center gap-2 px-2 text-[13px] text-sidebar-foreground/60">
            {history.isError
              ? "Threads could not be loaded."
              : "Your threads will appear here once you start one."}
          </div>
        </SidebarGroupContent>
      </SidebarGroup>
    );

  return (
    <SidebarGroup className="pt-0 group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel className={HEADING_CLASS}>History</SidebarGroupLabel>
      <SidebarGroupContent>
        <div className="flex flex-col gap-2">
          {groups.map(([repositoryUrl, items]) => {
            const visible = visibleByRepo[repositoryUrl] ?? PAGE_SIZE;

            const label = repositoryUrl
              ? new URL(repositoryUrl).pathname.slice(1).replace(/\.git$/, "")
              : "No repository";

            return (
              <Collapsible className="group/repo" defaultOpen key={repositoryUrl}>
                <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-[12px] font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground">
                  <ChevronRightIcon className="size-3.5 shrink-0 transition-transform duration-150 group-data-[state=open]/repo:rotate-90" />
                  <span className="truncate" title={label}>
                    {label}
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <SidebarMenu>
                    {items.slice(0, visible).map((thread) => (
                      <ThreadItem
                        active={thread.id === activeId}
                        key={thread.id}
                        onAction={setAction}
                        onNavigate={closeMobile}
                        thread={thread}
                        userId={userId}
                      />
                    ))}
                  </SidebarMenu>
                  {items.length > visible ? (
                    <button
                      className="px-2 py-1 text-left text-[11px] text-sidebar-foreground/50 hover:text-sidebar-foreground"
                      onClick={() =>
                        setVisibleByRepo((current) => ({
                          ...current,
                          [repositoryUrl]: visible + PAGE_SIZE,
                        }))
                      }
                      type="button"
                    >
                      Show more
                    </button>
                  ) : null}
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>

        <div ref={sentinel} />

        {isFetchNextPageError ? (
          <button
            className="mt-1 px-4 py-2 text-left text-[11px] text-sidebar-foreground/50 hover:text-sidebar-foreground"
            onClick={() => void fetchNextPage()}
            type="button"
          >
            Could not load more. Retry
          </button>
        ) : hasNextPage ? (
          <div className="mt-1 flex flex-row items-center gap-2 px-4 py-2 text-sidebar-foreground/50">
            <LoaderIcon className="size-3.5 animate-spin" />
            <div className="text-[11px]">Loading...</div>
          </div>
        ) : null}
        <ThreadActionDialog action={action} onClose={() => setAction(null)} userId={userId} />
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

/** Repository groups in order of their newest thread; threads arrive newest first. */
function groupThreads(threads: readonly ThreadSummary[]): [string, ThreadSummary[]][] {
  return [...Map.groupBy(threads, (thread) => thread.repositoryUrl ?? "").entries()];
}

function ThreadItem({
  active,
  onAction,
  onNavigate,
  thread,
  userId,
}: {
  active: boolean;
  onAction: (action: ThreadAction) => void;
  onNavigate: () => void;
  thread: ThreadSummary;
  userId: string;
}) {
  const queryClient = useQueryClient();
  const prefetch = () => void queryClient.prefetchQuery(threadQueryOptions(userId, thread.id));
  const diff = thread.diffStat && thread.diffStat.files > 0 ? thread.diffStat : null;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <SidebarMenuItem>
          <SidebarMenuButton
            asChild
            className="h-auto flex-col items-stretch gap-0.5 rounded-lg py-1.5 text-[13px] text-sidebar-foreground/50 transition-colors duration-150 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground data-active:bg-sidebar-accent data-active:text-sidebar-foreground"
            isActive={active}
          >
            <Link
              params={{ id: thread.id }}
              to="/agent/$id"
              onClick={onNavigate}
              // Start the snapshot read on hover, focus, or touch, before
              // the click lands; the default stale time lets the page reuse it.
              onFocus={prefetch}
              onPointerEnter={prefetch}
              onTouchStart={prefetch}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {thread.runStatus === "queued" || thread.runStatus === "running" ? (
                  <Spinner className="size-3 shrink-0" />
                ) : null}
                <span className="truncate">{thread.title ?? "New agent"}</span>
              </span>
              {thread.repositoryBranch || diff || thread.pullRequest ? (
                <span className="flex min-w-0 items-center justify-between gap-2 text-[11px] text-sidebar-foreground/40">
                  <span className="truncate">{thread.repositoryBranch}</span>
                  {thread.pullRequest ? <PullRequestIcon state={thread.pullRequest.state} /> : null}
                  {diff ? (
                    <span className="shrink-0 tabular-nums">
                      <span className="text-emerald-500">+{diff.additions}</span>{" "}
                      <span className="text-red-500">-{diff.deletions}</span>
                    </span>
                  ) : null}
                </span>
              ) : null}
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onAction({ kind: "rename", thread })}>
          <PencilIcon />
          Rename
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => onAction({ kind: "delete", thread })}
          variant="destructive"
        >
          <Trash2Icon />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
