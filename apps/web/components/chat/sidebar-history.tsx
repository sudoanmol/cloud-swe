"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { isToday, isYesterday, subMonths, subWeeks } from "date-fns";
import { LoaderIcon } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import type { ThreadSummary } from "@cloud-swe/api/contracts";
import { threadsQueryOptions } from "@/lib/queries";

type Groups = {
  today: ThreadSummary[];
  yesterday: ThreadSummary[];
  lastWeek: ThreadSummary[];
  lastMonth: ThreadSummary[];
  older: ThreadSummary[];
};

const SKELETON_WIDTHS = [44, 32, 28, 64, 52];

const HEADING_CLASS =
  "text-[10px] font-semibold uppercase tracking-[0.12em] text-sidebar-foreground/70";

/**
 * Thread history from the paginated backend list. The opaque cursor is passed
 * back untouched; unknown dates fall back to the title-only group.
 */
export function SidebarHistory({ userId }: { userId: string }) {
  const params = useParams<{ id?: string }>();
  const activeId = params.id;
  const { setOpenMobile } = useSidebar();

  const history = useInfiniteQuery({
    ...threadsQueryOptions(userId),
    // Rows that are still running or still waiting for their generated title go
    // stale on their own; poll only while such a row is on screen.
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.threads.some((thread) => thread.runStatus !== null || thread.title === null),
      )
        ? 5_000
        : false,
  });

  const threads = history.data?.pages.flatMap((page) => page.threads) ?? [];
  const groups = groupThreads(threads);

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
      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
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
      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
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
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel className={HEADING_CLASS}>History</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          <div className="flex flex-col gap-4">
            {(
              [
                ["Today", groups.today],
                ["Yesterday", groups.yesterday],
                ["Last 7 days", groups.lastWeek],
                ["Last 30 days", groups.lastMonth],
                ["Older", groups.older],
              ] as const
            ).map(([label, items]) =>
              items.length === 0 ? null : (
                <div key={label}>
                  <div className={`px-2 py-1 ${HEADING_CLASS}`}>{label}</div>
                  {items.map((thread) => (
                    <SidebarMenuItem key={thread.id}>
                      <SidebarMenuButton
                        asChild
                        className="h-8 rounded-none text-[13px] text-sidebar-foreground/50 transition-all duration-150 hover:bg-transparent hover:text-sidebar-foreground data-active:bg-transparent data-active:font-normal data-active:text-sidebar-foreground/50 data-[active=true]:border-b data-[active=true]:border-dashed data-[active=true]:border-sidebar-foreground/50 data-[active=true]:font-medium data-[active=true]:text-sidebar-foreground"
                        isActive={thread.id === activeId}
                      >
                        <Link href={`/chat/${thread.id}`} onClick={closeMobile}>
                          <span className="truncate">{thread.title ?? "New thread"}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </div>
              ),
            )}
          </div>
        </SidebarMenu>

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
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function groupThreads(threads: readonly ThreadSummary[]): Groups {
  const now = new Date();
  const oneWeekAgo = subWeeks(now, 1);
  const oneMonthAgo = subMonths(now, 1);
  const groups: Groups = { lastMonth: [], lastWeek: [], older: [], today: [], yesterday: [] };

  for (const thread of threads) {
    const created = new Date(thread.createdAt);

    if (isToday(created)) groups.today.push(thread);
    else if (isYesterday(created)) groups.yesterday.push(thread);
    else if (created > oneWeekAgo) groups.lastWeek.push(thread);
    else if (created > oneMonthAgo) groups.lastMonth.push(thread);
    else groups.older.push(thread);
  }

  return groups;
}
