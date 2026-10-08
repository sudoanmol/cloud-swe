import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";

import type { PublicAttachmentMetadata } from "@cloud-swe/api/contracts";
import { useAccountGuard } from "@/lib/account-scope";
import {
  MAX_CONCURRENT_UPLOADS,
  attachmentRejectionMessage,
  planAttachments,
  uploadWithConcurrency,
} from "@/lib/attachments";
import { deleteAttachmentMutation, uploadAttachmentMutation } from "@/lib/queries";
import { messageForError } from "@/lib/submission-errors";

/** Uploads, removals and their errors for one composer. */
export function useComposerAttachments(userId: string, supportsImages: boolean) {
  const accountIsCurrent = useAccountGuard();
  const [attachments, setAttachments] = useState<PublicAttachmentMetadata[]>([]);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  // Queued counts every selection that has not settled yet, so two overlapping
  // file picks cannot together exceed the message quota.
  const [queued, setQueued] = useState(0);
  // Mirrors `queued` synchronously: a second file pick that starts before React
  // re-renders must not open a second batch of uploads.
  const batchRunning = useRef(false);
  const upload = useMutation(uploadAttachmentMutation());
  const remove = useMutation(deleteAttachmentMutation());

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || batchRunning.current) return;

    batchRunning.current = true;
    setUploadErrors([]);

    const plan = planAttachments({
      accepted: attachments.map((attachment) => ({
        name: attachment.filename,
        size: attachment.size ?? 0,
        type: attachment.detectedMimeType,
      })),
      alreadyQueued: queued,
      incoming: Array.from(files),
      supportsImages,
    });

    setUploadErrors(plan.rejected.map(attachmentRejectionMessage));

    if (plan.accepted.length === 0) {
      batchRunning.current = false;

      return;
    }

    setQueued((current) => current + plan.accepted.length);

    try {
      // Results are index-aligned with the selection, so attachments land in the
      // order the user picked them even when uploads finish out of order.
      const outcomes = await uploadWithConcurrency(plan.accepted, MAX_CONCURRENT_UPLOADS, (file) =>
        upload.mutateAsync(file),
      );

      const uploaded: PublicAttachmentMetadata[] = [];
      const failures: string[] = [];

      for (const outcome of outcomes) {
        if (outcome.status === "fulfilled") uploaded.push(outcome.value);
        else failures.push(`${outcome.file.name}: ${messageForError(outcome.reason)}`);
      }

      // A sign-out or an account switch must not add these files to the next
      // account's composer.
      if (accountIsCurrent(userId)) {
        setAttachments((current) => [...current, ...uploaded]);
        setUploadErrors((current) => [...current, ...failures]);
      }
    } finally {
      if (accountIsCurrent(userId)) setQueued(0);
      batchRunning.current = false;
    }
  };

  const handleRemove = async (attachment: PublicAttachmentMetadata) => {
    setAttachments((current) => current.filter((candidate) => candidate.id !== attachment.id));

    try {
      await remove.mutateAsync(attachment.id);
    } catch {
      if (accountIsCurrent(userId))
        setUploadErrors((current) => [
          ...current,
          `${attachment.filename} could not be removed; it will not be sent.`,
        ]);
    }
  };

  return {
    attachments,
    uploadErrors,
    clearUploadErrors: () => setUploadErrors([]),
    queued,
    handleFiles,
    handleRemove,
  };
}
