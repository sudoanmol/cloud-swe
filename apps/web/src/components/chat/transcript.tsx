import { AlertTriangleIcon, ChevronRightIcon, InfoIcon, RotateCcwIcon } from "lucide-react";
import { useState } from "react";

import { MessageScrollerItem } from "@/components/ui/message-scroller";
import { groupTranscript } from "@/lib/tool-presentation";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageContent } from "@/components/ui/message";
import { Spinner } from "@/components/ui/spinner";
import type { QuestionRequest, RunStatus } from "@cloud-swe/api/contracts";
import type { TranscriptEntry } from "@/lib/chat-types";
import { cn } from "@/lib/utils";

import { Markdown } from "./markdown";
import { QuestionSummary } from "./question-card";
import { ToolCard, ToolGroupCard } from "./tool-cards";
import { UserMessage } from "./user-message";

/**
 * Renders the merged transcript. The scroller only re-pins to the bottom while
 * the reader is already there; otherwise the "scroll to end" button appears.
 */
export function Transcript({
  entries,
  footer,
  questions = [],
  waiting = null,
}: {
  entries: readonly TranscriptEntry[];
  footer?: React.ReactNode;
  questions?: readonly QuestionRequest[];
  /** Label for an active run that has no streaming text to show progress. */
  waiting?: string | null;
}) {
  const items = groupTranscript(entries).map((entry) => (
    <MessageScrollerItem key={entry.key} messageId={entry.key} scrollAnchor={entry.kind === "user"}>
      {entry.kind === "tool-group" ? (
        <ToolGroupCard group={entry} />
      ) : (
        <Entry entry={entry} questions={questions} />
      )}
    </MessageScrollerItem>
  ));

  return (
    <>
      {items}
      {waiting ? (
        <MessageScrollerItem messageId="run:waiting">
          <Message data-testid="message-assistant-loading">
            <WaitingText>{waiting}</WaitingText>
          </Message>
        </MessageScrollerItem>
      ) : null}
      {footer}
    </>
  );
}

function WaitingText({ children }: { children: string }) {
  return (
    <div className="flex min-h-[calc(13px*1.65)] min-w-0 items-center text-[13px] leading-[1.65]">
      <span className="animate-[shimmer_2s_linear_infinite] bg-[linear-gradient(90deg,var(--color-muted-foreground)_40%,var(--color-foreground)_50%,var(--color-muted-foreground)_60%)] bg-[length:200%_100%] bg-clip-text font-medium text-transparent">
        {children}
      </span>
    </div>
  );
}

function Entry({
  entry,
  questions,
}: {
  entry: TranscriptEntry;
  questions: readonly QuestionRequest[];
}) {
  if (entry.kind === "marker" && entry.questionRequestId) {
    const request = questions.find((candidate) => candidate.id === entry.questionRequestId);

    if (request && request.state !== "pending") return <QuestionSummary request={request} />;
  }

  switch (entry.kind) {
    case "user":
      return (
        <UserMessage attachments={entry.attachments} delivery={entry.delivery} text={entry.text} />
      );
    case "assistant":
      return (
        <Message>
          <MessageContent className="gap-2">
            {entry.part.reasoning?.trim() ? (
              <Reasoning
                text={entry.part.reasoning}
                thinking={entry.part.state === "streaming" && !entry.part.text}
              />
            ) : null}
            {entry.part.text ? (
              <Markdown
                className="text-[13px] leading-[1.65]"
                streaming={entry.part.state === "streaming"}
              >
                {entry.part.text}
              </Markdown>
            ) : null}
            {entry.part.truncated ? (
              <p className="text-xs text-muted-foreground">This message was truncated.</p>
            ) : null}
            {entry.part.state === "partial" ? (
              <Marker>
                <MarkerIcon>
                  <AlertTriangleIcon />
                </MarkerIcon>
                <MarkerContent>Generation stopped before this reply finished.</MarkerContent>
              </Marker>
            ) : null}
          </MessageContent>
        </Message>
      );
    case "tool":
      return <ToolCard part={entry.part} />;
    case "marker":
      return (
        <Marker variant="separator">
          <MarkerIcon>{entry.tone === "info" ? <InfoIcon /> : <AlertTriangleIcon />}</MarkerIcon>
          <MarkerContent className={cn(entry.tone === "error" && "text-destructive")}>
            {entry.text}
          </MarkerContent>
        </Marker>
      );
  }
}

/** Collapsed model reasoning; the latest summary heading names what it is doing. */
function Reasoning({ text, thinking }: { text: string; thinking: boolean }) {
  const [open, setOpen] = useState(false);
  const heading = [...text.matchAll(/^\*\*(.+?)\*\*\s*$/gm)].at(-1)?.[1];
  const label = thinking ? "Thinking" : "Thought";

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="flex max-w-full min-w-0 items-center gap-1.5 text-left text-[13px] leading-[1.65] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRightIcon
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
        {thinking ? <WaitingText>{label}</WaitingText> : <span>{label}</span>}
        {heading ? <span className="min-w-0 truncate">· {heading}</span> : null}
      </CollapsibleTrigger>
      {open ? (
        <CollapsibleContent className="mt-1 border-l-2 border-border/60 pl-3 text-muted-foreground">
          <Markdown className="text-[13px] leading-[1.65]" streaming={thinking}>
            {text}
          </Markdown>
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}

/** Run lifecycle marker, so a queued or failed run is never a silent gap. */
export function RunMarker({
  status,
  error,
  liveStopped,
  onRetry,
}: {
  status: RunStatus | "unknown";
  error: string | null;
  liveStopped?: boolean;
  onRetry?: () => void;
}) {
  if (status === "failed")
    return (
      <Marker variant="border">
        <MarkerIcon>
          <AlertTriangleIcon />
        </MarkerIcon>
        <MarkerContent className="flex flex-wrap items-center gap-2">
          <span>Run failed.</span>
          {error ? <span className="text-xs">{error}</span> : null}
          {onRetry ? (
            <button
              className="inline-flex items-center gap-1 text-xs underline underline-offset-3"
              onClick={onRetry}
              type="button"
            >
              <RotateCcwIcon className="size-3" />
              Retry
            </button>
          ) : null}
        </MarkerContent>
      </Marker>
    );

  if (status === "cancelled")
    return (
      <Marker variant="border">
        <MarkerIcon>
          <AlertTriangleIcon />
        </MarkerIcon>
        <MarkerContent>Cancelled.</MarkerContent>
      </Marker>
    );

  if (liveStopped)
    return (
      <Marker variant="border">
        <MarkerIcon>
          <AlertTriangleIcon />
        </MarkerIcon>
        <MarkerContent>Live updates stopped. Reload to catch up.</MarkerContent>
      </Marker>
    );

  return null;
}

export function StatusBadge({ status }: { status: RunStatus | "unknown" | null }) {
  if (!status) return <Badge variant="outline">Idle</Badge>;

  const label =
    status === "queued"
      ? "Queued"
      : status === "running"
        ? "Running"
        : status === "completed"
          ? "Done"
          : status === "failed"
            ? "Failed"
            : status === "cancelled"
              ? "Cancelled"
              : "Unknown";

  return (
    <Badge variant={status === "running" || status === "queued" ? "secondary" : "outline"}>
      {status === "running" || status === "queued" ? <Spinner className="size-3" /> : null}
      {label}
    </Badge>
  );
}
