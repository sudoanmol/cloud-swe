import { ManualGit } from "./manual-git";
import { manualGitStatusQueryOptions } from "@/lib/queries";
import { PullRequestStatus } from "./pull-request-status";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderTreeIcon, GitCompareArrowsIcon, GlobeIcon } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

import { ThreadApiError } from "@cloud-swe/api/client";
import type { PublicAttachmentMetadata } from "@cloud-swe/api/contracts";
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
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { applyThreadEvents, reconcileThreadSnapshot, staleQueries } from "@/lib/thread-projection";
import { buildTranscript, isActiveRun, submissionEntry } from "@/lib/thread-transcript";
import { useEventBatcher, useThreadEvents } from "@/lib/use-thread-events";
import {
  answerQuestionMutation,
  cancelRunMutation,
  questionsQueryOptions,
  workspaceFeaturesQueryOptions,
  submitEnvelopeMutation,
  updatePendingMessageMutation,
  startQueuedMessageMutation,
  threadQueryOptions,
  threadProjectionQueryOptions,
} from "@/lib/queries";
import {
  clearEnvelope,
  createEnvelope,
  loadEnvelope,
  saveEnvelope,
  type SubmissionEnvelope,
} from "@/lib/submission";
import { useModelSelection } from "@/hooks/use-model-selection";
import { addOptimistic, clearOptimistic, optimisticQueryOptions } from "@/lib/optimistic";
import { isRetryable, messageForError } from "@/lib/submission-errors";
import { clearDraft } from "@/lib/drafts";
import { useAccountGuard } from "@/lib/account-scope";
import { Composer, type ComposerHandle } from "./composer";
import { QuestionCard } from "./question-card";
import { ChatCard, ChatHeader } from "./product-shell";
import { RunMarker, StatusBadge, Transcript } from "./transcript";
import type { WorkspaceTab } from "./workspace-panel";

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

function ThreadView({ userId, threadId }: { userId: string; threadId: string }) {
  const snapshot = useQuery(threadQueryOptions(userId, threadId));

  const {
    selection: modelSelection,
    setSelection: onModelSelectionChange,
    supportsImages,
  } = useModelSelection(userId, snapshot.data?.runs.findLast((run) => !run.manual)?.modelSelection);

  // A conversation that already carries an image keeps text-only attachments.
  const hasThreadImages =
    snapshot.data?.messages.some((message) =>
      message.attachments.some((attachment) => attachment.classification === "image"),
    ) ?? false;

  const queryClient = useQueryClient();
  const isCurrentAccount = useAccountGuard();
  const optimistic = useQuery(optimisticQueryOptions(userId, threadId));
  const [composerVersion, setComposerVersion] = useState(0);
  const [restored, setRestored] = useState(false);
  const pendingEnvelope = useRef<SubmissionEnvelope | null>(null);
  const features = useQuery(workspaceFeaturesQueryOptions(userId));
  const browserVisible = Boolean(features.data?.browser || features.data?.previews);
  const questions = useQuery(questionsQueryOptions(userId, threadId));
  const { data: projection } = useQuery(threadProjectionQueryOptions(userId, threadId));
  const projectionRef = useRef(projection);
  const [envelope, setEnvelope] = useState<SubmissionEnvelope | null>(null);
  const submit = useMutation(submitEnvelopeMutation());
  const cancel = useMutation(cancelRunMutation());
  const answer = useMutation(answerQuestionMutation());
  const updatePending = useMutation(updatePendingMessageMutation());
  const startQueued = useMutation(startQueuedMessageMutation());
  const composerRef = useRef<ComposerHandle>(null);

  useEffect(() => {
    const restored = loadEnvelope(window.sessionStorage, userId, threadId);

    pendingEnvelope.current = restored;
    setEnvelope(restored);
    setRestored(true);
  }, [threadId, userId]);

  const invalidateSnapshot = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["session", userId, "thread", threadId] });
    void queryClient.invalidateQueries({ queryKey: ["session", userId, "threads"] });
  }, [queryClient, threadId, userId]);

  const handleEvents = useEventBatcher((events, _cursor) => {
    const next = applyThreadEvents(projectionRef.current, events);
    projectionRef.current = next;
    queryClient.setQueryData(threadProjectionQueryOptions(userId, threadId).queryKey, next);

    // Run lifecycle and question boundaries change durable rows, so refetch the
    // snapshot and the question list instead of guessing their state. Replayed
    // events the cached snapshot already covers leave the snapshot alone.
    const stale = staleQueries(
      events,
      queryClient.getQueryData(threadQueryOptions(userId, threadId).queryKey)?.latestEventId ?? 0,
    );

    if (events.some((event) => event.type.startsWith("git.")))
      void queryClient.invalidateQueries({
        queryKey: ["session", userId, "thread", threadId, "git"],
      });
    // A new sandbox report changes which header Git actions apply.
    else if (events.some((event) => event.type === "diff.updated"))
      void queryClient.invalidateQueries({
        queryKey: manualGitStatusQueryOptions(userId, threadId).queryKey,
      });

    if (stale.snapshot) invalidateSnapshot();
    else if (stale.questions)
      void queryClient.invalidateQueries({
        queryKey: questionsQueryOptions(userId, threadId).queryKey,
      });
  });

  const readCursor = useCallback(() => projectionRef.current.cursor, []);

  const events = useThreadEvents({
    enabled: true,
    onConnected: invalidateSnapshot,
    onEvents: handleEvents,
    readCursor,
    threadId,
  });

  // Newer replayed facts override the REST snapshot for summary rendering;
  // the REST watermark itself is never advanced by replayed events.
  const view = useMemo(
    () => (snapshot.data ? reconcileThreadSnapshot(snapshot.data, projection) : undefined),
    [projection, snapshot.data],
  );

  const firstPendingMessage = view?.pendingMessages?.[0];

  const allRuns = useMemo(() => view?.runs ?? [], [view]);
  // Header Git actions are not conversation turns: status, stop and the composer ignore them.
  const runs = useMemo(() => allRuns.filter((run) => !run.manual), [allRuns]);
  const latestRun = runs.at(-1) ?? null;
  const running = latestRun ? isActiveRun(latestRun) : false;

  const pendingRun = optimistic.data.find(
    (message) => !runs.some((run) => run.id === message.runId),
  );

  const activeRunId = pendingRun?.runId ?? (running ? (latestRun?.id ?? null) : null);

  // A cancellation the backend has recorded but not yet finished: the run is
  // still active, so the stop control stays visible but inert.
  const cancelling =
    activeRunId !== null &&
    ((latestRun?.id === activeRunId && Boolean(latestRun.cancelRequestedAt)) ||
      (cancel.variables?.runId === activeRunId && (cancel.isPending || cancel.isSuccess)));

  useEffect(() => {
    const committed =
      snapshot.data?.messages.flatMap((message) =>
        message.clientMessageId ? [message.clientMessageId] : [],
      ) ?? [];

    if (optimistic.data.some((message) => committed.includes(message.clientMessageId)))
      clearOptimistic(queryClient, userId, threadId, committed);
  }, [optimistic.data, queryClient, snapshot.data, threadId, userId]);

  const history = useMemo(
    () =>
      buildTranscript({
        optimistic: optimistic.data,
        projection,
        snapshotMessages: view?.messages ?? [],
        snapshotRuns: allRuns,
        snapshotWatermark: view?.latestEventId ?? 0,
      }),
    [optimistic.data, projection, allRuns, view],
  );

  // A lost response leaves the envelope uncertain even though the server
  // committed it; the snapshot's message with the same identity confirms it.
  const envelopeCommitted =
    envelope !== null &&
    ((snapshot.data?.messages.some(
      (message) => message.clientMessageId === envelope.clientMessageId,
    ) ??
      false) ||
      (snapshot.data?.pendingMessages?.some(
        (message) => message.clientMessageId === envelope.clientMessageId,
      ) ??
        false));

  useEffect(() => {
    if (!envelopeCommitted || submit.isPending) return;
    acknowledgeEnvelope();
    submit.reset();
  });

  const entries =
    envelope && !envelopeCommitted
      ? [...history, submissionEntry(envelope, submit.isPending ? "sending" : "uncertain")]
      : history;

  // Streaming text already shows progress; a second "working" row would sit under it.
  const lastEntry = entries.at(-1);
  const streamingText = lastEntry?.kind === "assistant" && lastEntry.part.state === "streaming";

  const pendingQuestion =
    questions.data?.requests.find((request) => request.state === "pending") ?? null;

  /** The server accepted the envelope: release it and reset the composer. */
  function acknowledgeEnvelope() {
    clearEnvelope(window.sessionStorage, userId, threadId);
    clearDraft(userId, `thread:${threadId}`);
    pendingEnvelope.current = null;
    setEnvelope(null);
    setComposerVersion((version) => version + 1);
  }

  const submitSaved = (next: SubmissionEnvelope) => {
    pendingEnvelope.current = next;
    setEnvelope(next);
    saveEnvelope(window.sessionStorage, userId, next);
    submit.mutate(next, {
      onSuccess: (result) => {
        if (!isCurrentAccount(userId)) return;
        acknowledgeEnvelope();

        if (result.delivery !== "pending")
          addOptimistic(queryClient, userId, {
            attachments: next.attachments,
            clientMessageId: next.clientMessageId,
            runId: result.runId,
            threadId: result.threadId,
            text: next.prompt,
          });
        invalidateSnapshot();
      },
      onError: (error) => {
        if (!isCurrentAccount(userId) || isRetryable(error)) return;
        clearEnvelope(window.sessionStorage, userId, threadId);
        pendingEnvelope.current = null;
        setEnvelope(null);
        invalidateSnapshot();
      },
    });
  };

  const send = (input: {
    text: string;
    attachments: PublicAttachmentMetadata[];
    mode?: "steer" | "queue";
  }) => {
    if (!modelSelection || pendingEnvelope.current || !restored) return;

    const next = createEnvelope({
      attachments: input.attachments,
      modelSelection,
      prompt: input.text,
      threadId,
      mode: input.mode,
    });

    submitSaved(next);
  };

  const diffStat = projection.diffStat;
  const isMobile = useIsMobile();
  const [panelOpen, setPanelOpen] = useState(false);
  // Null until the user picks a view; the panel then offers both.
  const [panelTab, setPanelTab] = useState<WorkspaceTab | null>(null);
  const panel = panelOpen ? panelTab : null;
  const [maximized, setMaximized] = useState(false);
  // Maximized hides the chat but keeps it mounted, so its scroll and draft survive.
  const panelMaximized = maximized && panelOpen && !isMobile;

  const openPanel = (tab: WorkspaceTab) => {
    setPanelTab(tab);
    setPanelOpen(true);
  };

  const togglePanel = (tab: WorkspaceTab) =>
    panelOpen && panelTab === tab ? setPanelOpen(false) : openPanel(tab);

  // ⌥⌘B (Ctrl+Alt+B): the secondary side bar shortcut in VS Code and Cursor.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.altKey || event.code !== "KeyB") return;
      event.preventDefault();
      setPanelOpen((open) => !open);
    };

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const workspacePanel = panelOpen ? (
    <Suspense fallback={<Spinner className="m-4 size-4" />}>
      <WorkspacePanel
        browser={projection.browser}
        features={features.data ?? { browser: false, previews: false }}
        diffStat={diffStat}
        editSequence={projection.editSequence}
        maximized={panelMaximized}
        onClose={() => setPanelOpen(false)}
        onToggleMaximize={isMobile ? undefined : () => setMaximized((value) => !value)}
        onTabChange={openPanel}
        tab={panelTab}
        threadId={threadId}
        userId={userId}
        workspaceState={view?.workspace?.state ?? null}
      />
    </Suspense>
  ) : null;

  return (
    <div className="flex h-dvh w-full min-w-0 flex-col bg-sidebar">
      <ChatHeader>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm font-medium">{view?.title ?? "New agent"}</span>
          <StatusBadge status={latestRun?.status ?? null} />
          <PullRequestStatus userId={userId} threadId={threadId} />
          {events.status === "reconnecting" ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Spinner className="size-3" />
              Reconnecting
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-0.5">
          {view?.repositoryUrl ? (
            <ManualGit
              onAskAgent={(prompt) => send({ text: prompt, attachments: [] })}
              running={running}
              threadId={threadId}
              userId={userId}
            />
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="Review changes"
                aria-pressed={panel === "changes"}
                className={cn(
                  "gap-1.5",
                  panel === "changes" ? "bg-accent" : "text-muted-foreground",
                )}
                onClick={() => togglePanel("changes")}
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
                aria-pressed={panel === "files"}
                className={cn(panel === "files" ? "bg-accent" : "text-muted-foreground")}
                onClick={() => togglePanel("files")}
                size="icon-sm"
                variant="ghost"
              >
                <FolderTreeIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Browse files</TooltipContent>
          </Tooltip>
          {browserVisible ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Browser"
                  aria-pressed={panel === "browser"}
                  className={cn(panel === "browser" ? "bg-accent" : "text-muted-foreground")}
                  onClick={() => togglePanel("browser")}
                  size="icon-sm"
                  variant="ghost"
                >
                  <GlobeIcon className="size-4" />
                  {projection.browser.active ? (
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
      </ChatHeader>

      <Group
        // Panel classes land on an inner element and its root sets display inline,
        // so hide the chat root by its id, with !important.
        className={cn(
          "min-h-0 flex-1",
          panelMaximized && "[&>#chat]:hidden! [&>[data-separator]]:hidden",
        )}
        orientation="horizontal"
      >
        <Panel className="flex flex-col" id="chat" minSize={360}>
          <ChatCard>
            <MessageScrollerProvider autoScroll defaultScrollPosition="end">
              <MessageScroller className="min-h-0 flex-1">
                <MessageScrollerViewport>
                  <MessageScrollerContent className="mx-auto w-full max-w-4xl gap-5 px-2 py-6 md:gap-7 md:px-4">
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
                        <p className="text-sm text-destructive">
                          {messageForError(snapshot.error)}
                        </p>
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
                        <Button
                          onClick={() => window.location.reload()}
                          variant="outline"
                          size="sm"
                        >
                          Reload and reconnect
                        </Button>
                      </MessageScrollerItem>
                    ) : null}
                    <Transcript
                      gitContext={{ userId, threadId }}
                      questions={questions.data?.requests}
                      entries={entries}
                      waiting={
                        latestRun && running && !streamingText && events.status !== "stopped"
                          ? latestRun.status === "queued"
                            ? "Queued..."
                            : "Working..."
                          : null
                      }
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
                {diffStat && diffStat.files > 0 ? (
                  <div className="absolute bottom-4 left-1/2 flex h-7 -translate-x-1/2 items-center rounded-full border border-border/50 bg-card/90 text-xs shadow-[var(--shadow-float)] backdrop-blur-lg">
                    <button
                      className="flex h-full items-center gap-1.5 rounded-l-full pr-2.5 pl-3.5 hover:bg-card"
                      onClick={() => openPanel("changes")}
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
                ) : (
                  <MessageScrollerButton
                    className="h-7 rounded-full border border-border/50 bg-card/90 px-3.5 shadow-[var(--shadow-float)] backdrop-blur-lg hover:bg-card [&_svg]:size-3 [&_svg]:text-muted-foreground"
                    direction="end"
                  />
                )}
              </MessageScroller>
            </MessageScrollerProvider>

            <div className="sticky bottom-0 z-1 mx-auto flex w-full max-w-4xl flex-col gap-3 bg-background px-2 pb-3 md:px-4 md:pb-4">
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
                  error={answer.error}
                  onAnswer={(answers) =>
                    answer.mutate(
                      { answers, requestId: pendingQuestion.id, threadId },
                      { onSettled: invalidateSnapshot },
                    )
                  }
                  pending={answer.isPending}
                  request={pendingQuestion}
                  onOpenBrowser={() => openPanel("browser")}
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
                    The previous request may have been accepted. Retry the same submission to
                    recover its result.
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {envelope.clientMessageId.slice(0, 8)}
                  </span>
                  <Button
                    className="self-start"
                    onClick={() => submitSaved(envelope)}
                    size="sm"
                    variant="outline"
                  >
                    Retry the same submission
                  </Button>
                </div>
              ) : null}
              {(view?.pendingMessages ?? []).map((pending) => (
                <div
                  key={pending.id}
                  className="rounded-xl border border-border/40 px-3 py-2 text-sm"
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">
                      <span className="text-muted-foreground">
                        {pending.mode === "steer" ? "Steering" : "Queued"}:{" "}
                      </span>
                      {pending.content || "Attachments"}
                    </span>
                    {pending.mode === "queue" ? (
                      <>
                        <Button
                          size="sm"
                          type="button"
                          variant="ghost"
                          disabled={
                            updatePending.isPending ||
                            startQueued.isPending ||
                            envelope !== null ||
                            !restored
                          }
                          onClick={() => {
                            const restore = () =>
                              composerRef.current?.appendDraft({
                                text: pending.content,
                                attachments: pending.attachments,
                              });

                            updatePending.mutate(
                              { threadId, messageId: pending.id, prompt: null },
                              {
                                onSuccess: () => {
                                  restore();

                                  if (isCurrentAccount(userId)) invalidateSnapshot();
                                },
                                // A 4xx means it was not removed (e.g. it already started);
                                // a lost response may have removed it, so keep the text.
                                onError: (error) => {
                                  if (!(error instanceof ThreadApiError) || error.status >= 500)
                                    restore();
                                },
                              },
                            );
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          type="button"
                          variant="ghost"
                          disabled={
                            updatePending.isPending ||
                            startQueued.isPending ||
                            envelope !== null ||
                            !restored
                          }
                          onClick={() =>
                            updatePending.mutate(
                              { threadId, messageId: pending.id, prompt: null },
                              {
                                onSuccess: () => {
                                  if (isCurrentAccount(userId)) invalidateSnapshot();
                                },
                              },
                            )
                          }
                        >
                          Remove
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              ))}
              {!activeRunId && firstPendingMessage ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={startQueued.isPending || updatePending.isPending || envelope !== null}
                  onClick={() =>
                    startQueued.mutate(
                      { threadId, messageId: firstPendingMessage.id },
                      {
                        onSuccess: () => {
                          if (isCurrentAccount(userId)) invalidateSnapshot();
                        },
                      },
                    )
                  }
                >
                  Run queued
                </Button>
              ) : null}
              {startQueued.error ? (
                <p role="alert" className="text-sm text-destructive">
                  {messageForError(startQueued.error)}
                </p>
              ) : null}
              {updatePending.error ? (
                <p role="alert" className="text-sm text-destructive">
                  {messageForError(updatePending.error)}
                </p>
              ) : null}
              <Composer
                key={composerVersion}
                ref={composerRef}
                activeRunId={activeRunId}
                cancelling={cancelling}
                disabled={!restored || envelope !== null || !view}
                draftKey={`thread:${threadId}`}
                mentionThread={{
                  id: threadId,
                  running: view?.workspace?.state === "running",
                  repository: view?.repositoryUrl
                    ? { url: view.repositoryUrl, branch: view.repositoryBranch }
                    : null,
                }}
                hasThreadImages={hasThreadImages}
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
                placeholder={
                  activeRunId
                    ? "Enter to steer · Alt+Enter to queue"
                    : "Reply to continue. @ for files, $ for skills"
                }
                selection={modelSelection}
                submitting={submit.isPending || updatePending.isPending}
                usage={projection.usage}
                userId={userId}
              />
            </div>
          </ChatCard>
        </Panel>
        {panelOpen && !isMobile ? (
          <>
            <Separator className="w-px bg-border/60 transition-colors hover:bg-primary/40 data-[separator=active]:bg-primary/60" />
            <Panel defaultSize="45%" id="workspace" minSize={320}>
              {workspacePanel}
            </Panel>
          </>
        ) : null}
      </Group>
      {isMobile ? (
        <Sheet onOpenChange={setPanelOpen} open={panelOpen}>
          <SheetContent className="w-full p-0 sm:max-w-full" side="right">
            <SheetTitle className="sr-only">Workspace</SheetTitle>
            {workspacePanel}
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  );
}
