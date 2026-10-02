"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GithubIcon } from "lucide-react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useSessionUser } from "@/components/auth/session-provider";
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
import { Spinner } from "@/components/ui/spinner";
import type { ThreadStreamEvent } from "@cloud-swe/api/client";
import type { ThreadProjection } from "@/lib/chat-types";
import {
  applyReplayPage,
  applyThreadEvents,
  reconcileThreadSnapshot,
} from "@/lib/thread-projection";
import { buildTranscript, isActiveRun, submissionEntry } from "@/lib/thread-transcript";
import { useThreadEvents } from "@/lib/use-thread-events";
import {
  answerQuestionMutation,
  cancelRunMutation,
  questionsQueryOptions,
  submitEnvelopeMutation,
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
import { Composer } from "./composer";
import { QuestionCard } from "./question-card";
import { ChatCard, ChatHeader } from "./product-shell";
import { RunMarker, StatusBadge, Transcript } from "./transcript";

/**
 * `/agent/[id]`: the committed snapshot plus the live event projection. The
 * reader stays connected for an idle thread too, so late title and workspace
 * events still land.
 */
export function ThreadPage() {
  const { id: threadId } = useParams<{ id: string }>();

  return <ThreadView key={threadId} threadId={threadId} userId={useSessionUser().id} />;
}

function ThreadView({ userId, threadId }: { userId: string; threadId: string }) {
  const snapshot = useQuery(threadQueryOptions(userId, threadId));

  const {
    selection: modelSelection,
    setSelection: onModelSelectionChange,
    supportsImages,
  } = useModelSelection(userId, snapshot.data?.runs.at(-1)?.modelSelection);

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
  const questions = useQuery(questionsQueryOptions(userId, threadId));
  const { data: projection } = useQuery(threadProjectionQueryOptions(userId, threadId));
  const projectionRef = useRef(projection);
  const [envelope, setEnvelope] = useState<SubmissionEnvelope | null>(null);
  const submit = useMutation(submitEnvelopeMutation());
  const cancel = useMutation(cancelRunMutation());
  const answer = useMutation(answerQuestionMutation());

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

  const commitProjection = (next: ThreadProjection, events: readonly ThreadStreamEvent[]) => {
    projectionRef.current = next;
    queryClient.setQueryData(threadProjectionQueryOptions(userId, threadId).queryKey, next);

    // Run lifecycle and question boundaries change durable rows, so refetch the
    // snapshot and the question list instead of guessing their state. Replayed
    // events the cached snapshot already covers change nothing.
    const watermark =
      queryClient.getQueryData(threadQueryOptions(userId, threadId).queryKey)?.latestEventId ?? 0;

    if (
      events.some(
        (event) =>
          event.sequence > watermark &&
          (event.type.startsWith("run.") ||
            event.type.startsWith("questions.") ||
            event.type.startsWith("workspace.") ||
            event.type === "thread.title.updated"),
      )
    )
      invalidateSnapshot();
  };

  const readCursor = useCallback(() => projectionRef.current.cursor, []);

  const events = useThreadEvents({
    enabled: true,
    onConnected: invalidateSnapshot,
    onEvents: (batch) => commitProjection(applyThreadEvents(projectionRef.current, batch), batch),
    onReplay: (page) => commitProjection(applyReplayPage(projectionRef.current, page), page.events),
    readCursor,
    threadId,
  });

  // Newer replayed facts override the REST snapshot for summary rendering;
  // the REST watermark itself is never advanced by replayed events.
  const view = useMemo(
    () => (snapshot.data ? reconcileThreadSnapshot(snapshot.data, projection) : undefined),
    [projection, snapshot.data],
  );

  const runs = useMemo(() => view?.runs ?? [], [view]);
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
        snapshotRuns: runs,
        snapshotWatermark: view?.latestEventId ?? 0,
      }),
    [optimistic.data, projection, runs, view],
  );

  const entries = envelope
    ? [...history, submissionEntry(envelope, submit.isPending ? "sending" : "uncertain")]
    : history;

  // Streaming text already shows progress; a second "working" row would sit under it.
  const lastEntry = entries.at(-1);
  const streamingText = lastEntry?.kind === "assistant" && lastEntry.part.state === "streaming";

  const pendingQuestion =
    questions.data?.requests.find((request) => request.state === "pending") ?? null;

  const submitSaved = (next: SubmissionEnvelope) => {
    pendingEnvelope.current = next;
    setEnvelope(next);
    saveEnvelope(window.sessionStorage, userId, next);
    submit.mutate(next, {
      onSuccess: (result) => {
        if (!isCurrentAccount(userId)) return;
        clearEnvelope(window.sessionStorage, userId, threadId);
        clearDraft(userId, `thread:${threadId}`);
        pendingEnvelope.current = null;
        setEnvelope(null);
        addOptimistic(queryClient, userId, {
          attachmentIds: next.attachmentIds,
          clientMessageId: next.clientMessageId,
          runId: result.runId,
          threadId: result.threadId,
          text: next.prompt,
        });
        setComposerVersion((version) => version + 1);
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

  const send = (input: { text: string; attachmentIds: string[] }) => {
    if (!modelSelection || pendingEnvelope.current || activeRunId || !restored) return;

    const next = createEnvelope({
      attachmentIds: input.attachmentIds,
      modelSelection,
      prompt: input.text,
      threadId,
    });

    submitSaved(next);
  };

  const repositoryUrl = view?.repositoryUrl ?? null;

  return (
    <div className="flex h-dvh w-full min-w-0 flex-col bg-sidebar">
      <ChatHeader>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm font-medium">{view?.title ?? "New agent"}</span>
          <StatusBadge status={latestRun?.status ?? null} />
          {events.status === "reconnecting" ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Spinner className="size-3" />
              Reconnecting
            </span>
          ) : null}
        </div>
        {repositoryUrl ? (
          <a
            className="hidden max-w-56 items-center gap-1.5 truncate text-xs text-muted-foreground underline-offset-3 hover:underline sm:flex"
            href={repositoryUrl}
            rel="noreferrer noopener"
            target="_blank"
          >
            <GithubIcon className="size-3.5 shrink-0" />
            <span className="truncate">
              {repositoryUrl.replace(/^https:\/\/github\.com\//, "")}
              {view?.repositoryBranch ? `@${view.repositoryBranch}` : ""}
            </span>
          </a>
        ) : null}
      </ChatHeader>

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
                <Transcript
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
                          workspaceUnavailable={events.status === "stopped"}
                        />
                      </MessageScrollerItem>
                    ) : null
                  }
                />
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton
              className="h-7 rounded-full border border-border/50 bg-card/90 px-3.5 shadow-[var(--shadow-float)] backdrop-blur-lg hover:bg-card [&_svg]:size-3 [&_svg]:text-muted-foreground"
              direction="end"
            />
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
                The previous request may have been accepted. Retry the same submission to recover
                its result.
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
          <Composer
            key={composerVersion}
            activeRunId={activeRunId}
            cancelling={cancelling}
            disabled={!restored || envelope !== null || pendingQuestion !== null || !view}
            draftKey={`thread:${threadId}`}
            hasThreadImages={hasThreadImages}
            supportsImages={supportsImages}
            error={null}
            onCancel={() => {
              if (activeRunId)
                cancel.mutate({ runId: activeRunId, threadId }, { onSuccess: invalidateSnapshot });
            }}
            onSelectionChange={onModelSelectionChange}
            onSubmit={send}
            placeholder="Reply to continue this thread"
            selection={modelSelection}
            submitting={submit.isPending}
            userId={userId}
          />
        </div>
      </ChatCard>
    </div>
  );
}
