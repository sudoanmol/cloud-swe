"use client";

import { AlertTriangleIcon, InfoIcon, RotateCcwIcon, SparklesIcon } from "lucide-react";

import { AttachmentGroup } from "@/components/ui/attachment";
import { AttachmentPreview } from "./attachment-preview";
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import { groupTranscript } from "@/lib/tool-presentation";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageContent } from "@/components/ui/message";
import { Spinner } from "@/components/ui/spinner";
import type {
  PublicAttachmentMetadata,
  QuestionRequest,
  RunStatus,
} from "@cloud-swe/api/contracts";
import type { TranscriptEntry } from "@/lib/chat-types";
import { cn } from "@/lib/utils";

import { Markdown } from "./markdown";
import { QuestionSummary } from "./question-card";
import { ToolCard, ToolGroupCard } from "./tool-cards";

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
  // One avatar per assistant turn: later text, tools and the waiting row after
  // it share the avatar's column instead of repeating it.
  let avatarShown = false;

  const items = groupTranscript(entries).map((entry) => {
    if (entry.kind === "user") avatarShown = false;

    const showAvatar = entry.kind === "assistant" && !avatarShown;

    if (showAvatar) avatarShown = true;

    return (
      <MessageScrollerItem
        key={entry.key}
        messageId={entry.key}
        scrollAnchor={entry.kind === "user"}
      >
        {entry.kind === "tool-group" ? (
          <AssistantColumn>
            <ToolGroupCard group={entry} />
          </AssistantColumn>
        ) : (
          <Entry entry={entry} questions={questions} showAvatar={showAvatar} />
        )}
      </MessageScrollerItem>
    );
  });

  return (
    <>
      {items}
      {waiting ? (
        <MessageScrollerItem messageId="run:waiting">
          <Message className="items-start gap-3" data-testid="message-assistant-loading">
            {avatarShown ? <span className="w-7 shrink-0" /> : <AssistantAvatar />}
            <WaitingText>{waiting}</WaitingText>
          </Message>
        </MessageScrollerItem>
      ) : null}
      {footer}
    </>
  );
}

function AssistantAvatar() {
  return (
    <div className="flex h-[calc(13px*1.65)] shrink-0 items-center">
      <div className="flex size-7 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground ring-1 ring-border/50">
        <SparklesIcon className="size-[13px]" />
      </div>
    </div>
  );
}

/** Aligns tool output with assistant text, to the right of the avatar column. */
function AssistantColumn({ children }: { children: React.ReactNode }) {
  return <div className="min-w-0 pl-10">{children}</div>;
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
  showAvatar,
}: {
  entry: TranscriptEntry;
  questions: readonly QuestionRequest[];
  showAvatar: boolean;
}) {
  if (entry.kind === "marker" && entry.questionRequestId) {
    const request = questions.find((candidate) => candidate.id === entry.questionRequestId);

    if (request && request.state !== "pending") return <QuestionSummary request={request} />;
  }

  switch (entry.kind) {
    case "user":
      return (
        <Message align="end" className="animate-[fade-up_0.25s_cubic-bezier(0.22,1,0.36,1)]">
          <MessageContent className="items-end gap-2">
            {entry.attachments.length > 0 ? (
              <AttachmentStrip attachments={entry.attachments} />
            ) : null}
            <Bubble align="end" className="max-w-[min(80%,56ch)]" variant="secondary">
              <BubbleContent className="rounded-2xl rounded-br-lg border-border/30 bg-gradient-to-br from-secondary to-muted px-3.5 py-2 text-[13px] leading-[1.65] whitespace-pre-wrap shadow-[var(--shadow-card)]">
                {entry.text}
              </BubbleContent>
            </Bubble>
            {entry.pending ? (
              <span className="flex items-center gap-1.5 self-end text-xs text-muted-foreground">
                <Spinner className="size-3" />
                Sending
              </span>
            ) : null}
          </MessageContent>
        </Message>
      );
    case "assistant":
      return (
        <Message className="items-start gap-3">
          {showAvatar ? <AssistantAvatar /> : <span className="w-7 shrink-0" />}
          <MessageContent className="gap-2">
            <Markdown
              className="text-[13px] leading-[1.65]"
              streaming={entry.part.state === "streaming"}
            >
              {entry.part.text}
            </Markdown>
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
      return (
        <AssistantColumn>
          <ToolCard part={entry.part} />
        </AssistantColumn>
      );
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

/** Run lifecycle marker, so a queued or failed run is never a silent gap. */
export function RunMarker({
  status,
  error,
  workspaceUnavailable,
  onRetry,
}: {
  status: RunStatus | "unknown";
  error: string | null;
  workspaceUnavailable?: boolean;
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

  if (workspaceUnavailable)
    return (
      <Marker variant="border">
        <MarkerIcon>
          <AlertTriangleIcon />
        </MarkerIcon>
        <MarkerContent>
          Live output unavailable. The next reconnect or reload will catch up.
        </MarkerContent>
      </Marker>
    );

  return null;
}

export function AttachmentStrip({
  attachments,
}: {
  attachments: readonly PublicAttachmentMetadata[];
}) {
  return (
    <AttachmentGroup aria-label="Attachments" role="group" tabIndex={0}>
      {attachments.map((attachment) => (
        <AttachmentPreview key={attachment.id} attachment={attachment} />
      ))}
    </AttachmentGroup>
  );
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
