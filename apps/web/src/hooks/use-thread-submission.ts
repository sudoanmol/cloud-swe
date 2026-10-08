import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import type { PublicAttachmentMetadata, ThreadSnapshot } from "@cloud-swe/api/contracts";
import type { ModelSelection } from "@cloud-swe/db/model-contracts";
import { useAccountGuard } from "@/lib/account-scope";
import { clearDraft } from "@/lib/drafts";
import { addOptimistic } from "@/lib/optimistic";
import { submitEnvelopeMutation } from "@/lib/queries";
import {
  clearEnvelope,
  createEnvelope,
  loadEnvelope,
  saveEnvelope,
  type SubmissionEnvelope,
} from "@/lib/submission";
import { isRetryable } from "@/lib/submission-errors";

/**
 * Follow-up submissions. The envelope is saved before sending, so a lost
 * response can be retried with the same identity and recovered, not duplicated.
 */
export function useThreadSubmission(
  userId: string,
  threadId: string,
  snapshotMessages: ThreadSnapshot["messages"] | undefined,
  invalidateSnapshot: () => void,
  modelSelection: ModelSelection | null,
  activeRunId: string | null,
) {
  const queryClient = useQueryClient();
  const isCurrentAccount = useAccountGuard();
  const [composerVersion, setComposerVersion] = useState(0);
  const [restored, setRestored] = useState(false);
  const pendingEnvelope = useRef<SubmissionEnvelope | null>(null);
  const [envelope, setEnvelope] = useState<SubmissionEnvelope | null>(null);
  const submit = useMutation(submitEnvelopeMutation());

  useEffect(() => {
    const restored = loadEnvelope(window.sessionStorage, userId, threadId);

    pendingEnvelope.current = restored;
    setEnvelope(restored);
    setRestored(true);
  }, [threadId, userId]);

  // A lost response leaves the envelope uncertain even though the server
  // committed it; the snapshot's message with the same identity confirms it.
  const envelopeCommitted =
    envelope !== null &&
    (snapshotMessages?.some((message) => message.clientMessageId === envelope.clientMessageId) ??
      false);

  useEffect(() => {
    if (!envelopeCommitted || submit.isPending) return;
    acknowledgeEnvelope();
    submit.reset();
  });

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

  const send = (input: { text: string; attachments: PublicAttachmentMetadata[] }) => {
    if (!modelSelection || pendingEnvelope.current || activeRunId || !restored) return;

    const next = createEnvelope({
      attachments: input.attachments,
      modelSelection,
      prompt: input.text,
      threadId,
    });

    submitSaved(next);
  };

  return { envelope, envelopeCommitted, submit, submitSaved, send, restored, composerVersion };
}
