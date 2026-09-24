"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { useAccountGuard } from "@/lib/account-scope";
import { useModelSelection } from "@/hooks/use-model-selection";
import { addOptimistic } from "@/lib/optimistic";
import { submitEnvelopeMutation } from "@/lib/queries";
import { clearDraft } from "@/lib/drafts";
import {
  clearEnvelope,
  createEnvelope,
  loadEnvelope,
  saveEnvelope,
  type SubmissionEnvelope,
} from "@/lib/submission";
import { isRetryable, messageForError } from "@/lib/submission-errors";

import { Composer } from "./composer";
import { RightSidebarPlaceholder } from "./product-shell";

/**
 * `/`: a new thread. The composer keeps its own draft, attachments and optional
 * repository, then navigates to the created thread instead of rendering it here.
 */
export function NewThreadView({ userId }: { userId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const isCurrentAccount = useAccountGuard();
  const [envelope, setEnvelope] = useState<SubmissionEnvelope | null>(null);
  const pendingEnvelope = useRef<SubmissionEnvelope | null>(null);
  const [restored, setRestored] = useState(false);

  const {
    selection: modelSelection,
    setSelection: onModelSelectionChange,
    supportsImages,
  } = useModelSelection(userId);

  const [repository, setRepository] = useState<{ url: string; branch: string | null } | null>(null);
  const submit = useMutation(submitEnvelopeMutation());

  useEffect(() => {
    const saved = loadEnvelope(window.sessionStorage, userId, undefined);
    pendingEnvelope.current = saved;
    setEnvelope(saved);
    setRestored(true);
  }, [userId]);

  const send = (next: SubmissionEnvelope) => {
    pendingEnvelope.current = next;
    setEnvelope(next);
    saveEnvelope(window.sessionStorage, userId, next);
    submit.mutate(next, {
      onSuccess: (result) => {
        if (!isCurrentAccount(userId)) return;
        clearEnvelope(window.sessionStorage, userId, undefined);
        clearDraft(userId, "new-thread");
        addOptimistic(queryClient, userId, {
          attachmentIds: next.attachmentIds,
          clientMessageId: next.clientMessageId,
          runId: result.runId,
          text: next.prompt,
          threadId: result.threadId,
        });
        void queryClient.invalidateQueries({ queryKey: ["session", userId, "threads"] });
        router.push(`/chat/${result.threadId}`);
      },
      onError: (error) => {
        if (!isCurrentAccount(userId) || isRetryable(error)) return;
        clearEnvelope(window.sessionStorage, userId, undefined);
        pendingEnvelope.current = null;
        setEnvelope(null);
      },
    });
  };

  const updateRepository = useCallback(
    (next: { url: string; branch: string | null } | null) => setRepository(next),
    [],
  );

  return (
    <div className="flex h-dvh w-full min-w-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 px-3">
        <SidebarTrigger />
        <RightSidebarPlaceholder />
      </header>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-4">
        <h1 className="text-2xl font-medium">What can I help with?</h1>
        <div className="flex w-full max-w-3xl flex-col gap-3">
          {envelope && !submit.isPending ? (
            <div className="flex flex-col items-start gap-2 text-sm">
              <p>The previous request may have been accepted. Retry it before sending another.</p>
              <p className="max-w-full truncate text-xs text-muted-foreground">
                {envelope.prompt || "Attachments only"}
              </p>
              <Button onClick={() => send(envelope)} variant="outline">
                Retry the same submission
              </Button>
            </div>
          ) : null}
          <Composer
            activeRunId={null}
            disabled={!restored || envelope !== null}
            draftKey="new-thread"
            error={submit.isError ? messageForError(submit.error) : null}
            onCancel={() => undefined}
            onSelectionChange={onModelSelectionChange}
            onSubmit={(input) => {
              if (!modelSelection || !repository || pendingEnvelope.current || !restored) return;

              const envelope = createEnvelope({
                attachmentIds: input.attachmentIds,
                branch: repository.branch ?? undefined,
                modelSelection,
                prompt: input.text,
                repositoryUrl: repository.url,
              });

              send(envelope);
            }}
            placeholder="Ask anything, connect a repository, or run a command"
            repository={{ autoSelect: true, onChange: updateRepository, value: repository }}
            selection={modelSelection}
            supportsImages={supportsImages}
            submitBlockedReason={
              repository === null ? "Select a repository to start a thread." : null
            }
            submitting={submit.isPending}
            userId={userId}
          />
        </div>
      </div>
    </div>
  );
}
