"use client";

import { AlertTriangleIcon, InfoIcon, LoaderIcon, RotateCcwIcon } from "lucide-react";

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
}: {
  entries: readonly TranscriptEntry[];
  footer?: React.ReactNode;
  questions?: readonly QuestionRequest[];
}) {
  return (
    <>
      {groupTranscript(entries).map((entry) => (
        <MessageScrollerItem
          key={entry.key}
          messageId={entry.key}
          scrollAnchor={entry.kind === "user"}
        >
          {entry.kind === "tool-group" ? (
            <ToolGroupCard group={entry} />
          ) : (
            <Entry entry={entry} questions={questions} />
          )}
        </MessageScrollerItem>
      ))}
      {footer}
    </>
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
        <Message align="end">
          <MessageContent>
            {entry.attachments.length > 0 ? (
              <AttachmentStrip attachments={entry.attachments} />
            ) : null}
            <Bubble align="end" variant="secondary">
              <BubbleContent className="whitespace-pre-wrap">{entry.text}</BubbleContent>
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
        <Message>
          <MessageContent>
            <Markdown streaming={entry.part.state === "streaming"}>{entry.part.text}</Markdown>
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

/** Run lifecycle marker, so a queued or failed run is never a silent gap. */
export function RunMarker({
  status,
  error,
  active,
  workspaceUnavailable,
  onRetry,
}: {
  status: RunStatus | "unknown";
  error: string | null;
  active: boolean;
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

  if (active)
    return (
      <Marker>
        <MarkerIcon>
          <LoaderIcon className="animate-spin" />
        </MarkerIcon>
        <MarkerContent>
          {status === "queued" ? "Queued" : "Working"} — execution continues if you close this tab.
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
