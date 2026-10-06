import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  FolderTreeIcon,
  GitCompareArrowsIcon,
  GlobeIcon,
  Maximize2Icon,
  Minimize2Icon,
  XIcon,
} from "lucide-react";

import { ThreadApiError } from "@cloud-swe/api/client";
import type { WorkspaceDiffStat } from "@cloud-swe/db/workspace-review";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  wakeWorkspaceMutation,
  workspaceQueryKey,
  workspaceSummaryQueryOptions,
} from "@/lib/queries";
import { messageForError } from "@/lib/submission-errors";
import { cn } from "@/lib/utils";
import { WorkspaceBrowser } from "./workspace-browser";
import { WorkspaceChanges } from "./workspace-changes";
import { WorkspaceFiles } from "./workspace-files";

export type WorkspaceTab = "files" | "changes" | "browser";

/** Restoring a snapshot includes a readiness probe of up to a minute. */
const wakeTimeoutMs = 90_000;

function Status({ children, busy = false }: { children: React.ReactNode; busy?: boolean }) {
  return (
    <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
      {busy ? <Spinner className="size-3.5" /> : null}
      {children}
    </p>
  );
}

function stateMessage(state: string | null) {
  switch (state) {
    case null:
      return { text: "The workspace starts with the first run.", busy: false };
    case "paused":
      return { text: "Waking the workspace", busy: true };
    case "provisioning":
    case "recovery":
      return { text: "Preparing the workspace", busy: true };
    case "deleted":
      return { text: "The idle workspace was deleted. Send a message to rebuild it.", busy: false };
    default:
      return { text: "The workspace is unavailable.", busy: false };
  }
}

/** Browser-only: the panel only mounts after the user opens it. */
export default function WorkspacePanel({
  userId,
  threadId,
  tab,
  workspaceState,
  diffStat,
  browser,
  features,
  editSequence,
  onTabChange,
  onClose,
  maximized,
  onToggleMaximize,
}: {
  userId: string;
  threadId: string;
  tab: WorkspaceTab | null;
  workspaceState: string | null;
  diffStat: WorkspaceDiffStat | null;
  browser: { active: boolean; owner: "agent" | "user" };
  features: { browser: boolean; previews: boolean };
  /** Sequence of the latest event that may have changed workspace files. */
  editSequence: number;
  onTabChange: (tab: WorkspaceTab) => void;
  onClose: () => void;
  maximized: boolean;
  /** Absent where the panel already fills the screen. */
  onToggleMaximize?: () => void;
}) {
  const queryClient = useQueryClient();
  const running = workspaceState === "running";
  const wake = useMutation(wakeWorkspaceMutation());

  const summary = useQuery({
    ...workspaceSummaryQueryOptions(userId, threadId),
    enabled: running,
  });

  // Opening the panel wakes a paused sandbox once. The idle pause still runs,
  // so a later pause waits for the user instead of re-waking in a loop.
  const pausedForSummary =
    summary.error instanceof ThreadApiError && summary.error.code === "WORKSPACE_PAUSED";

  const { mutate: requestWake, reset: resetWake } = wake;
  const autoWake = useRef(true);

  useEffect(() => {
    if (!autoWake.current || (workspaceState !== "paused" && !pausedForSummary)) return;
    autoWake.current = false;
    requestWake(threadId);
  }, [pausedForSummary, requestWake, threadId, workspaceState]);

  // An accepted wake can still fail in the workflow; stop waiting eventually.
  const [wakeTimedOut, setWakeTimedOut] = useState(false);

  useEffect(() => {
    if (!wake.isSuccess || workspaceState !== "paused") return;
    const timer = setTimeout(() => setWakeTimedOut(true), wakeTimeoutMs);

    return () => clearTimeout(timer);
  }, [wake.isSuccess, wake.submittedAt, workspaceState]);

  // Once awake, the next pause shows the Wake button again.
  useEffect(() => {
    if (!running) return;
    resetWake();
    setWakeTimedOut(false);
  }, [resetWake, running]);

  // Results loaded before an idle pause stay visible until the user wakes it.
  const [loaded, setLoaded] = useState(running);

  if (running && !loaded) setLoaded(true);

  // Any mutating tool may change files even when the totals stay the same.
  const seenEdit = useRef(editSequence);

  useEffect(() => {
    if (seenEdit.current === editSequence) return;
    seenEdit.current = editSequence;
    void queryClient.invalidateQueries({ queryKey: workspaceQueryKey(userId, threadId) });
  }, [editSequence, queryClient, threadId, userId]);

  const message = stateMessage(workspaceState);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        {(
          [
            ["changes", "Changes", GitCompareArrowsIcon],
            ["files", "Files", FolderTreeIcon],
            ["browser", "Browser", GlobeIcon],
          ] as const
        ).map(([value, label, Icon]) =>
          value === "browser" && !features.browser && !features.previews ? null : (
            <Button
              aria-pressed={tab === value}
              className={cn("gap-1.5", tab === value ? "bg-accent" : "text-muted-foreground")}
              key={value}
              onClick={() => onTabChange(value)}
              size="sm"
              variant="ghost"
            >
              <Icon className="size-3.5" />
              {label}
              {value === "changes" && diffStat && diffStat.files > 0 ? (
                <span className="text-xs tabular-nums">
                  <span className="text-emerald-500">+{diffStat.additions}</span>{" "}
                  <span className="text-red-500">-{diffStat.deletions}</span>
                </span>
              ) : null}
            </Button>
          ),
        )}
        {onToggleMaximize ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={maximized ? "Restore panel" : "Maximize panel"}
                aria-pressed={maximized}
                className="ml-auto"
                onClick={onToggleMaximize}
                size="icon-sm"
                variant="ghost"
              >
                {maximized ? (
                  <Minimize2Icon className="size-4" />
                ) : (
                  <Maximize2Icon className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{maximized ? "Show the chat" : "Hide the chat"}</TooltipContent>
          </Tooltip>
        ) : null}
        <Button
          aria-label="Close panel"
          className={cn(!onToggleMaximize && "ml-auto")}
          onClick={onClose}
          size="icon-sm"
          variant="ghost"
        >
          <XIcon className="size-4" />
        </Button>
      </div>

      {running ? null : wake.isError ||
        wakeTimedOut ||
        (workspaceState === "paused" && wake.isIdle) ? (
        <div className="flex items-center gap-3 border-b border-border/60 p-3 text-sm text-muted-foreground">
          {wake.isError
            ? messageForError(wake.error)
            : wakeTimedOut
              ? "The workspace did not wake."
              : "The workspace paused while idle."}
          <Button
            onClick={() => {
              setWakeTimedOut(false);
              requestWake(threadId);
            }}
            size="sm"
            variant="outline"
          >
            Wake
          </Button>
        </div>
      ) : (
        <Status busy={message.busy}>{message.text}</Status>
      )}
      {tab === null ? (
        <div className="flex flex-col gap-2 p-3">
          <Button
            className="w-full justify-start gap-2"
            onClick={() => onTabChange("changes")}
            variant="outline"
          >
            <GitCompareArrowsIcon className="size-4" />
            Review changes
          </Button>
          <Button
            className="w-full justify-start gap-2"
            onClick={() => onTabChange("files")}
            variant="outline"
          >
            <FolderTreeIcon className="size-4" />
            View files
          </Button>
          {features.browser || features.previews ? (
            <Button
              className="w-full justify-start gap-2"
              onClick={() => onTabChange("browser")}
              variant="outline"
            >
              <GlobeIcon className="size-4" />
              Open browser
            </Button>
          ) : null}
        </div>
      ) : !loaded ? null : tab === "changes" ? (
        <WorkspaceChanges
          live={running}
          summary={summary.data}
          threadId={threadId}
          userId={userId}
        />
      ) : tab === "files" ? (
        <WorkspaceFiles live={running} threadId={threadId} userId={userId} />
      ) : (
        <WorkspaceBrowser
          browser={browser}
          features={features}
          live={running}
          threadId={threadId}
          userId={userId}
        />
      )}
    </div>
  );
}
