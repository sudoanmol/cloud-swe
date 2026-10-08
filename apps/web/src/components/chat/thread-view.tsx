import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { FolderTreeIcon, GitCompareArrowsIcon, GlobeIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

import type { QuestionRequest, ThreadSnapshot } from "@cloud-swe/api/contracts";
import type { WorkspaceDiffStat } from "@cloud-swe/db/workspace-review";
import { useSessionUser } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Message, MessageContent } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { OptimisticMessage, ThreadProjection, TranscriptEntry } from "@/lib/chat-types";
import { reconcileThreadSnapshot } from "@/lib/thread-projection";
import { buildTranscript, isActiveRun, submissionEntry } from "@/lib/thread-transcript";
import type { ThreadEventSource } from "@/lib/use-thread-events";
import {
  answerQuestionMutation,
  cancelRunMutation,
  questionsQueryOptions,
  workspaceFeaturesQueryOptions,
  threadQueryOptions,
} from "@/lib/queries";
import type { SubmissionEnvelope } from "@/lib/submission";
import { useModelSelection } from "@/hooks/use-model-selection";
import { useThreadLive } from "@/hooks/use-thread-live";
import { useThreadSubmission } from "@/hooks/use-thread-submission";
import { useWorkspacePanel } from "@/hooks/use-workspace-panel";
import { clearOptimistic, optimisticQueryOptions } from "@/lib/optimistic";
import { messageForError } from "@/lib/submission-errors";
import { Composer } from "./composer";
import { QuestionCard } from "./question-card";
import { ChatCard, ChatHeader } from "./product-shell";
import { RunMarker, StatusBadge, Transcript } from "./transcript";

// Pierre diffs and trees are browser-only; the panel loads when first opened.
const WorkspacePanel = lazy(() => import("./workspace-panel"));

/**
 * `/agent/$id`: the committed snapshot plus the live event projection. The
 * reader stays connected for an idle thread too, so late title and workspace
 * events still land.
 */
export function ThreadPage({ threadId }: { threadId: string }) {
  return <ThreadView key={threadId} threadId={threadId} userId={useSessionUser().id} />;
}

type WorkspacePanelState = ReturnType<typeof useWorkspacePanel>;

function ThreadView({ userId, threadId }: { userId: string; threadId: string }) {
  const snapshot = useQuery(threadQueryOptions(userId, threadId));

  const {
    selection: modelSelection,
    setSelection: onModelSelectionChange,
    supportsImages,
  } = useModelSelection(userId, snapshot.data?.runs.at(-1)?.modelSelection);

  const optimistic = useQuery(optimisticQueryOptions(userId, threadId));
  const features = useQuery(workspaceFeaturesQueryOptions(userId));
  const questions = useQuery(questionsQueryOptions(userId, threadId));
  const { projection, events, invalidateSnapshot } = useThreadLive(userId, threadId);
  const cancel = useMutation(cancelRunMutation());
  const answer = useMutation(answerQuestionMutation());
  const panel = useWorkspacePanel();

  // Newer replayed facts override the REST snapshot for summary rendering;
  // the REST watermark itself is never advanced by replayed events.
  const view = useMemo(
    () => (snapshot.data ? reconcileThreadSnapshot(snapshot.data, projection) : undefined),
    [projection, snapshot.data],
  );

  const runs = useMemo(() => view?.runs ?? [], [view]);

  const { latestRun, running, activeRunId, cancelling } = describeRunActivity(
    runs,
    optimistic.data,
    cancel.variables?.runId,
    cancel.isPending || cancel.isSuccess,
  );

  const { envelope, envelopeCommitted, submit, submitSaved, send, restored, composerVersion } =
    useThreadSubmission(
      userId,
      threadId,
      snapshot.data?.messages,
      invalidateSnapshot,
      modelSelection,
      activeRunId,
    );

  useDropCommittedOptimistic(userId, threadId, optimistic.data, snapshot.data?.messages);

  const entries = useTranscriptEntries(
    optimistic.data,
    projection,
    view,
    runs,
    envelope && !envelopeCommitted ? envelope : null,
    submit.isPending,
  );

  const pendingQuestion =
    questions.data?.requests.find((request) => request.state === "pending") ?? null;

  const diffStat = projection.diffStat;

  const workspacePanel = (
    <ThreadWorkspacePanel
      features={features.data}
      panel={panel}
      projection={projection}
      threadId={threadId}
      userId={userId}
      workspaceState={view?.workspace?.state ?? null}
    />
  );

  return (
    <div className="flex h-dvh w-full min-w-0 flex-col bg-sidebar">
      <ChatHeader>
        <ThreadHeader
          browserActive={projection.browser.active}
          diffStat={diffStat}
          features={features.data}
          latestRun={latestRun}
          panel={panel}
          reconnecting={events.status === "reconnecting"}
          view={view}
        />
      </ChatHeader>

      <PanelLayout panel={panel} workspacePanel={workspacePanel}>
        <ChatCard>
          <MessageScrollerProvider autoScroll defaultScrollPosition="end">
            <MessageScroller className="min-h-0 flex-1">
              <MessageScrollerViewport>
                <MessageScrollerContent className="mx-auto w-full max-w-4xl gap-5 px-2 py-6 md:gap-7 md:px-4">
                  <ThreadLoadState events={events} snapshot={snapshot} />
                  <Transcript
                    questions={questions.data?.requests}
                    entries={entries}
                    waiting={waitingLabel(latestRun, running, entries, events.status)}
                    footer={
                      latestRun ? (
                        <MessageScrollerItem messageId={`run:${latestRun.id}`}>
                          <RunMarker
                            error={latestRun.error}
                            status={latestRun.status}
                            liveStopped={events.status === "stopped"}
                          />
                        </MessageScrollerItem>
                      ) : null
                    }
                  />
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <ScrollControls diffStat={diffStat} onOpenChanges={() => panel.openTab("changes")} />
            </MessageScroller>
          </MessageScrollerProvider>

          <div className="sticky bottom-0 z-1 mx-auto flex w-full max-w-4xl flex-col gap-3 bg-background px-2 pb-3 md:px-4 md:pb-4">
            <ThreadNotices
              answerError={answer.error}
              answerPending={answer.isPending}
              cancel={cancel}
              onAnswer={(requestId, answers) =>
                answer.mutate({ answers, requestId, threadId }, { onSettled: invalidateSnapshot })
              }
              onOpenBrowser={() => panel.openTab("browser")}
              onRetryEnvelope={submitSaved}
              pendingQuestion={pendingQuestion}
              questions={questions}
              envelope={envelope}
              submit={submit}
            />
            <Composer
              key={composerVersion}
              activeRunId={activeRunId}
              cancelling={cancelling}
              disabled={!restored || envelope !== null || pendingQuestion !== null || !view}
              draftKey={`thread:${threadId}`}
              mentionThread={mentionThreadOf(threadId, view)}
              hasThreadImages={threadHasImages(snapshot.data?.messages)}
              supportsImages={supportsImages}
              error={null}
              onCancel={() => {
                if (activeRunId)
                  cancel.mutate(
                    { runId: activeRunId, threadId },
                    { onSuccess: invalidateSnapshot },
                  );
              }}
              onSelectionChange={onModelSelectionChange}
              onSubmit={send}
              placeholder="Reply to continue. @ for files, $ for skills"
              selection={modelSelection}
              submitting={submit.isPending}
              usage={projection.usage}
              userId={userId}
            />
          </div>
        </ChatCard>
      </PanelLayout>
    </div>
  );
}

/** A conversation that already carries an image keeps text-only attachments. */
function threadHasImages(messages: ThreadSnapshot["messages"] | undefined): boolean {
  return (
    messages?.some((message) =>
      message.attachments.some((attachment) => attachment.classification === "image"),
    ) ?? false
  );
}

function mentionThreadOf(threadId: string, view: ThreadSnapshot | undefined) {
  return {
    id: threadId,
    running: view?.workspace?.state === "running",
    repository: view?.repositoryUrl
      ? { url: view.repositoryUrl, branch: view.repositoryBranch }
      : null,
  };
}

/**
 * Which run the composer treats as active. An optimistic message whose run the
 * snapshot does not list yet counts as active before the snapshot catches up.
 */
function describeRunActivity(
  runs: ThreadSnapshot["runs"],
  optimistic: readonly OptimisticMessage[],
  cancelledRunId: string | undefined,
  cancelInFlightOrDone: boolean,
) {
  const latestRun = runs.at(-1) ?? null;
  const running = latestRun ? isActiveRun(latestRun) : false;
  const pendingRun = optimistic.find((message) => !runs.some((run) => run.id === message.runId));
  const activeRunId = pendingRun?.runId ?? (running ? (latestRun?.id ?? null) : null);

  // A cancellation the backend has recorded but not yet finished: the run is
  // still active, so the stop control stays visible but inert.
  const cancelling =
    activeRunId !== null &&
    ((latestRun?.id === activeRunId && Boolean(latestRun.cancelRequestedAt)) ||
      (cancelledRunId === activeRunId && cancelInFlightOrDone));

  return { latestRun, running, activeRunId, cancelling };
}

function ThreadHeader({
  view,
  latestRun,
  features,
  reconnecting,
  diffStat,
  browserActive,
  panel,
}: {
  view: ThreadSnapshot | undefined;
  latestRun: ThreadSnapshot["runs"][number] | null;
  features: { browser: boolean; previews: boolean } | undefined;
  reconnecting: boolean;
  diffStat: WorkspaceDiffStat | null;
  browserActive: boolean;
  panel: Pick<WorkspacePanelState, "visibleTab" | "toggleTab">;
}) {
  const { visibleTab, toggleTab } = panel;

  return (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-sm font-medium">{view?.title ?? "New agent"}</span>
        <StatusBadge status={latestRun?.status ?? null} />
        {reconnecting ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            Reconnecting
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Review changes"
              aria-pressed={visibleTab === "changes"}
              className={cn(
                "gap-1.5",
                visibleTab === "changes" ? "bg-accent" : "text-muted-foreground",
              )}
              onClick={() => toggleTab("changes")}
              size="sm"
              variant="ghost"
            >
              <GitCompareArrowsIcon className="size-4" />
              {diffStat && diffStat.files > 0 ? (
                <span className="text-xs tabular-nums">
                  <span className="text-emerald-500">+{diffStat.additions}</span>{" "}
                  <span className="text-red-500">-{diffStat.deletions}</span>
                </span>
              ) : null}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Review changes</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Browse files"
              aria-pressed={visibleTab === "files"}
              className={cn(visibleTab === "files" ? "bg-accent" : "text-muted-foreground")}
              onClick={() => toggleTab("files")}
              size="icon-sm"
              variant="ghost"
            >
              <FolderTreeIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Browse files</TooltipContent>
        </Tooltip>
        {features?.browser || features?.previews ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="Browser"
                aria-pressed={visibleTab === "browser"}
                className={cn(visibleTab === "browser" ? "bg-accent" : "text-muted-foreground")}
                onClick={() => toggleTab("browser")}
                size="icon-sm"
                variant="ghost"
              >
                <GlobeIcon className="size-4" />
                {browserActive ? (
                  <span
                    aria-label="Agent is browsing"
                    className="size-2 rounded-full bg-emerald-500"
                  />
                ) : null}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Browser</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </>
  );
}

/** Loading, snapshot-error and live-update-stopped rows at the top of the transcript. */
function ThreadLoadState({
  snapshot,
  events,
}: {
  snapshot: Pick<UseQueryResult<ThreadSnapshot>, "isPending" | "isError" | "error" | "refetch">;
  events: ThreadEventSource;
}) {
  return (
    <>
      {snapshot.isPending ? (
        <MessageScrollerItem messageId="thread:loading">
          <Message>
            <MessageContent>
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner className="size-3.5" />
                Loading thread
              </span>
            </MessageContent>
          </Message>
        </MessageScrollerItem>
      ) : null}
      {snapshot.isError ? (
        <MessageScrollerItem messageId="thread:error">
          <p className="text-sm text-destructive">{messageForError(snapshot.error)}</p>
          <Button onClick={() => void snapshot.refetch()} variant="outline" size="sm">
            Retry
          </Button>
        </MessageScrollerItem>
      ) : null}
      {events.status === "stopped" ? (
        <MessageScrollerItem messageId="stream-error">
          <p className="text-sm text-destructive">
            Live updates stopped. {events.error ? messageForError(events.error) : ""}
          </p>
          <Button onClick={() => window.location.reload()} variant="outline" size="sm">
            Reload and reconnect
          </Button>
        </MessageScrollerItem>
      ) : null}
    </>
  );
}

/** The jump-to-latest button, joined to a changed-files pill when the diff is non-empty. */
function ScrollControls({
  diffStat,
  onOpenChanges,
}: {
  diffStat: WorkspaceDiffStat | null;
  onOpenChanges: () => void;
}) {
  if (!diffStat || diffStat.files === 0)
    return (
      <MessageScrollerButton
        className="h-7 rounded-full border border-border/50 bg-card/90 px-3.5 shadow-[var(--shadow-float)] backdrop-blur-lg hover:bg-card [&_svg]:size-3 [&_svg]:text-muted-foreground"
        direction="end"
      />
    );

  return (
    <div className="absolute bottom-4 left-1/2 flex h-7 -translate-x-1/2 items-center rounded-full border border-border/50 bg-card/90 text-xs shadow-[var(--shadow-float)] backdrop-blur-lg">
      <button
        className="flex h-full items-center gap-1.5 rounded-l-full pr-2.5 pl-3.5 hover:bg-card"
        onClick={onOpenChanges}
        type="button"
      >
        {diffStat.files} {diffStat.files === 1 ? "file" : "files"}
        <span className="tabular-nums">
          <span className="text-emerald-500">+{diffStat.additions}</span>{" "}
          <span className="text-red-500">-{diffStat.deletions}</span>
        </span>
      </button>
      <span aria-hidden className="h-4 w-px bg-border" />
      <MessageScrollerButton
        className="static h-full translate-x-0 rounded-l-none rounded-r-full border-0 bg-transparent pr-3 pl-2.5 hover:bg-card data-[active=false]:pointer-events-none data-[active=false]:scale-100 data-[active=false]:opacity-40 data-[direction=end]:data-[active=false]:translate-y-0 [&_svg]:size-3 [&_svg]:text-muted-foreground"
        direction="end"
      />
    </div>
  );
}

/** Optimistic rows are dropped once the snapshot carries the committed message. */
function useDropCommittedOptimistic(
  userId: string,
  threadId: string,
  optimistic: readonly OptimisticMessage[],
  snapshotMessages: ThreadSnapshot["messages"] | undefined,
) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const committed =
      snapshotMessages?.flatMap((message) =>
        message.clientMessageId ? [message.clientMessageId] : [],
      ) ?? [];

    if (optimistic.some((message) => committed.includes(message.clientMessageId)))
      clearOptimistic(queryClient, userId, threadId, committed);
  }, [optimistic, queryClient, snapshotMessages, threadId, userId]);
}

/** Streaming text already shows progress; a second "working" row would sit under it. */
function waitingLabel(
  latestRun: ThreadSnapshot["runs"][number] | null,
  running: boolean,
  entries: readonly TranscriptEntry[],
  liveStatus: ThreadEventSource["status"],
): string | null {
  const lastEntry = entries.at(-1);
  const streamingText = lastEntry?.kind === "assistant" && lastEntry.part.state === "streaming";

  if (!latestRun || !running || streamingText || liveStatus === "stopped") return null;

  return latestRun.status === "queued" ? "Queued..." : "Working...";
}

/** Question, cancel and submission problems shown above the composer. */
function ThreadNotices({
  questions,
  pendingQuestion,
  answerError,
  answerPending,
  cancel,
  submit,
  envelope,
  onAnswer,
  onOpenBrowser,
  onRetryEnvelope,
}: {
  questions: { isError: boolean; error: Error | null; refetch: () => void };
  pendingQuestion: QuestionRequest | null;
  answerError: Error | null;
  answerPending: boolean;
  cancel: { isError: boolean; error: Error | null };
  submit: { isError: boolean; isPending: boolean; error: Error | null };
  /** An envelope with no settled answer: the same submission must be retried. */
  envelope: SubmissionEnvelope | null;
  onAnswer: (requestId: string, answers: Record<string, string>) => void;
  onOpenBrowser: () => void;
  onRetryEnvelope: (envelope: SubmissionEnvelope) => void;
}) {
  return (
    <>
      {questions.isError ? (
        <Alert variant="destructive">
          <AlertDescription>
            <p>Could not refresh questions. {messageForError(questions.error)}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void questions.refetch()}
            >
              Retry questions
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {pendingQuestion ? (
        <QuestionCard
          key={pendingQuestion.id}
          error={answerError}
          onAnswer={(answers) => onAnswer(pendingQuestion.id, answers)}
          pending={answerPending}
          request={pendingQuestion}
          onOpenBrowser={onOpenBrowser}
        />
      ) : null}
      {cancel.isError ? (
        <p className="text-xs text-destructive">{messageForError(cancel.error)}</p>
      ) : null}
      {submit.isError ? (
        <p className="text-xs text-destructive">{messageForError(submit.error)}</p>
      ) : null}
      {envelope && !submit.isPending ? (
        <div className="flex flex-col gap-1 text-xs text-destructive">
          <span>
            The previous request may have been accepted. Retry the same submission to recover its
            result.
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {envelope.clientMessageId.slice(0, 8)}
          </span>
          <Button
            className="self-start"
            onClick={() => onRetryEnvelope(envelope)}
            size="sm"
            variant="outline"
          >
            Retry the same submission
          </Button>
        </div>
      ) : null}
    </>
  );
}

function ThreadWorkspacePanel({
  panel,
  userId,
  threadId,
  projection,
  features,
  workspaceState,
}: {
  panel: WorkspacePanelState;
  userId: string;
  threadId: string;
  projection: ThreadProjection;
  features: { browser: boolean; previews: boolean } | undefined;
  workspaceState: string | null;
}) {
  if (!panel.open) return null;

  return (
    <Suspense fallback={<Spinner className="m-4 size-4" />}>
      <WorkspacePanel
        browser={projection.browser}
        features={features ?? { browser: false, previews: false }}
        diffStat={projection.diffStat}
        editSequence={projection.editSequence}
        maximized={panel.maximized}
        onClose={() => panel.setOpen(false)}
        onToggleMaximize={panel.isMobile ? undefined : panel.toggleMaximized}
        onTabChange={panel.openTab}
        tab={panel.tab}
        threadId={threadId}
        userId={userId}
        workspaceState={workspaceState}
      />
    </Suspense>
  );
}

/** The chat beside the workspace panel on desktop, or under it as a sheet on mobile. */
function PanelLayout({
  panel,
  workspacePanel,
  children,
}: {
  panel: WorkspacePanelState;
  workspacePanel: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <>
      <Group
        // Panel classes land on an inner element and its root sets display inline,
        // so hide the chat root by its id, with !important.
        className={cn(
          "min-h-0 flex-1",
          panel.maximized && "[&>#chat]:hidden! [&>[data-separator]]:hidden",
        )}
        orientation="horizontal"
      >
        <Panel className="flex flex-col" id="chat" minSize={360}>
          {children}
        </Panel>
        {panel.open && !panel.isMobile ? (
          <>
            <Separator className="w-px bg-border/60 transition-colors hover:bg-primary/40 data-[separator=active]:bg-primary/60" />
            <Panel defaultSize="45%" id="workspace" minSize={320}>
              {workspacePanel}
            </Panel>
          </>
        ) : null}
      </Group>
      {panel.isMobile ? (
        <Sheet onOpenChange={panel.setOpen} open={panel.open}>
          <SheetContent className="w-full p-0 sm:max-w-full" side="right">
            <SheetTitle className="sr-only">Workspace</SheetTitle>
            {workspacePanel}
          </SheetContent>
        </Sheet>
      ) : null}
    </>
  );
}

/** The committed history, plus the submission the server has not confirmed yet. */
function useTranscriptEntries(
  optimistic: readonly OptimisticMessage[],
  projection: ThreadProjection,
  view: ThreadSnapshot | undefined,
  runs: ThreadSnapshot["runs"],
  unconfirmed: SubmissionEnvelope | null,
  sending: boolean,
): TranscriptEntry[] {
  const history = useMemo(
    () =>
      buildTranscript({
        optimistic,
        projection,
        snapshotMessages: view?.messages ?? [],
        snapshotRuns: runs,
        snapshotWatermark: view?.latestEventId ?? 0,
      }),
    [optimistic, projection, runs, view],
  );

  return unconfirmed
    ? [...history, submissionEntry(unconfirmed, sending ? "sending" : "uncertain")]
    : history;
}
