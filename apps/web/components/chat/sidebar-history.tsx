"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { isToday, isYesterday, subMonths, subWeeks } from "date-fns";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback } from "react";

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
import { threadsQueryOptions } from "@/lib/queries";

type Groups = {
  today: ThreadSummary[];
  yesterday: ThreadSummary[];
  lastWeek: ThreadSummary[];
  lastMonth: ThreadSummary[];
  older: ThreadSummary[];
};

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

  return (
    <>
      {history.isPending ? (
        <SidebarGroup>
          <SidebarGroupContent>
            <div className="flex items-center gap-2 px-2 py-1.5 text-[13px] text-sidebar-foreground/50">
              <Spinner className="size-3" />
              Loading
            </div>
          </SidebarGroupContent>
        </SidebarGroup>
      ) : null}

      {threads.length === 0 && !history.isPending ? (
        <SidebarGroup>
          <SidebarGroupContent>
            <p className="px-2 py-1.5 text-[13px] text-sidebar-foreground/50">
              Your threads will appear here.
            </p>
          </SidebarGroupContent>
        </SidebarGroup>
      ) : null}

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
          <SidebarGroup className="py-1" key={label}>
            <SidebarGroupLabel className="px-2 text-[11px] text-sidebar-foreground/40">
              {label}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {items.map((thread) => (
                  <SidebarMenuItem key={thread.id}>
                    <SidebarMenuButton
                      asChild
                      className="h-8 rounded-lg text-[13px] text-sidebar-foreground/70 data-[active=true]:bg-sidebar-accent/60 data-[active=true]:text-sidebar-foreground"
                      isActive={thread.id === activeId}
                    >
                      <Link href={`/chat/${thread.id}`} onClick={closeMobile}>
                        <span className="truncate">{thread.title ?? "New thread"}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ),
      )}

      {history.hasNextPage ? (
        <SidebarGroup className="py-1">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  className="h-8 rounded-lg text-[13px] text-sidebar-foreground/60"
                  disabled={history.isFetchingNextPage}
                  onClick={() => void history.fetchNextPage()}
                >
                  {history.isFetchingNextPage ? <Spinner className="size-3" /> : null}
                  <span>Load more</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ) : null}
    </>
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
