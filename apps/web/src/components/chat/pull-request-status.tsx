import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GitPullRequestIcon, GitMergeIcon } from "lucide-react";
import type { ThreadPr } from "@cloud-swe/db/git-contracts";
import { pullRequestQueryOptions } from "@/lib/queries";
import { cn } from "@/lib/utils";

const prColors = {
  open: "text-green-500",
  closed: "text-red-500",
  merged: "text-purple-500",
  draft: "text-gray-500",
};

export function PullRequestIcon({ state }: { state: ThreadPr["state"] }) {
  const Icon = state === "merged" ? GitMergeIcon : GitPullRequestIcon;

  return (
    <Icon
      aria-label={`Pull request ${state}`}
      className={cn("size-3.5 shrink-0", prColors[state])}
    />
  );
}

export function PullRequestStatus({ userId, threadId }: { userId: string; threadId: string }) {
  const query = useQuery(pullRequestQueryOptions(userId, threadId));
  const client = useQueryClient();
  useEffect(() => {
    if (query.data) void client.invalidateQueries({ queryKey: ["session", userId, "threads"] });
  }, [query.data, client, userId]);

  if (!query.data)
    return query.isError ? (
      <span className="text-xs text-muted-foreground">PR status unavailable</span>
    ) : null;
  const pr = query.data;

  return (
    <a
      className="flex min-w-0 items-center gap-1.5 text-xs"
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      title={pr.title}
    >
      <PullRequestIcon state={pr.state} />
      <span className="truncate">
        #{pr.number} {pr.title}
      </span>
      <span>
        {pr.state} · {pr.checks.passed}/{pr.checks.total} checks passed
        {pr.checks.failed ? ` · ${pr.checks.failed} failed` : ""}
        {pr.checks.pending ? ` · ${pr.checks.pending} pending` : ""}
      </span>
    </a>
  );
}
