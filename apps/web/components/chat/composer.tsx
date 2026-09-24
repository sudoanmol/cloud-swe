"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangleIcon, ArrowUpIcon, PaperclipIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AttachmentAction } from "@/components/ui/attachment";
import { AttachmentPreview } from "@/components/chat/attachment-preview";
import {
  MAX_CONCURRENT_UPLOADS,
  attachmentRejectionMessage,
  planAttachments,
  submissionBlockReason,
  uploadWithConcurrency,
} from "@/lib/attachments";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { ATTACHMENT_MESSAGE_MAX_FILES } from "@cloud-swe/db/attachment-limits";
import type { PublicAttachmentMetadata } from "@cloud-swe/api/contracts";
import type { ModelSelection } from "@cloud-swe/db/model-contracts";
import { useAccountGuard } from "@/lib/account-scope";
import { readDraft, writeDraft } from "@/lib/drafts";
import {
  deleteAttachmentMutation,
  providerModelsQueryOptions,
  uploadAttachmentMutation,
} from "@/lib/queries";
import { messageForError } from "@/lib/submission-errors";

import { ModelPicker, RepositoryPicker } from "./pickers";

/** Every rule the composer advertises comes from the shared attachment limits. */

/** One composer for a new thread and for follow-ups. */
export function Composer({
  userId,
  draftKey,
  selection,
  onSelectionChange,
  repository,
  onSubmit,
  submitting,
  submittingLabel,
  disabled,
  placeholder,
  activeRunId,
  cancelling = false,
  hasThreadImages = false,
  supportsImages: supportsImagesProp,
  onCancel,
  error,
  submitBlockedReason = null,
  allowAttachments = true,
}: {
  userId: string;
  draftKey: string;
  selection: ModelSelection | null;
  onSelectionChange: (selection: ModelSelection) => void;
  repository?: {
    value: { url: string; branch: string | null } | null;
    onChange: (value: { url: string; branch: string | null } | null) => void;
    autoSelect?: boolean;
  };
  onSubmit: (input: { text: string; attachmentIds: string[] }) => void;
  submitting: boolean;
  submittingLabel?: string;
  disabled: boolean;
  placeholder: string;
  activeRunId: string | null;
  cancelling?: boolean;
  /** Whether the conversation already carries images (a thread-wide constraint). */
  hasThreadImages?: boolean;
  /** Model capability; derived from the catalog when the caller does not know. */
  supportsImages?: boolean;
  onCancel: () => void;
  error: string | null;
  /** Shown instead of sending when a product rule still blocks the submission. */
  submitBlockedReason?: string | null;
  allowAttachments?: boolean;
}) {
  const queryClient = useQueryClient();
  const accountIsCurrent = useAccountGuard();
  const [text, setText] = useState(() => readDraft(userId, draftKey));
  const [attachments, setAttachments] = useState<PublicAttachmentMetadata[]>([]);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  // Queued counts every selection that has not settled yet, so two overlapping
  // file picks cannot together exceed the message quota.
  const [queued, setQueued] = useState(0);
  // Mirrors `queued` synchronously: a second file pick that starts before React
  // re-renders must not open a second batch of uploads.
  const batchRunning = useRef(false);

  const catalog = useQuery({
    ...providerModelsQueryOptions(userId, selection?.provider ?? "vercel-ai-gateway"),
    enabled: selection !== null,
  });

  const selectedModel = catalog.data?.models.find((entry) => entry.id === selection?.model);
  const supportsImages = supportsImagesProp ?? selectedModel?.input.includes("image") ?? false;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const upload = useMutation(uploadAttachmentMutation());
  const remove = useMutation(deleteAttachmentMutation());

  useEffect(() => {
    writeDraft(userId, draftKey, text);
  }, [draftKey, text, userId]);

  useEffect(() => {
    const element = textareaRef.current;

    if (!element) return;

    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
  }, [text]);

  const hasContent = text.trim().length > 0 || attachments.length > 0;

  // The backend's classification is authoritative: a file whose browser type is
  // generic can still be an image the model must be able to read.
  const threadHasImages =
    hasThreadImages || attachments.some((attachment) => attachment.classification === "image");

  const uploadBlock = submissionBlockReason({ hasThreadImages: threadHasImages, supportsImages });

  const canSubmit =
    selection !== null &&
    uploadBlock === null &&
    // A missing selection would make Send a no-op while the catalogs load.
    !disabled &&
    !submitting &&
    // Uploads must settle first: an id that is still uploading cannot be sent.
    queued === 0 &&
    submitBlockedReason === null &&
    activeRunId === null &&
    hasContent;

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
    } finally {
      if (accountIsCurrent(userId)) void queryClient.invalidateQueries();
    }
  };

  const submit = () => {
    if (!canSubmit) return;

    onSubmit({
      text: text.trim(),
      attachmentIds: attachments.map((attachment) => attachment.id),
    });
  };

  return (
    <div className="flex w-full flex-col gap-2">
      {repository ? (
        <div className="flex min-w-0 items-center rounded-xl border border-border/60 bg-card/40 px-2 py-1">
          <RepositoryPicker
            autoSelect={repository.autoSelect}
            disabled={disabled || activeRunId !== null}
            onChange={repository.onChange}
            userId={userId}
            value={repository.value}
          />
        </div>
      ) : null}
      <InputGroup className="flex-col">
        {attachments.length > 0 ? (
          <div className="flex flex-wrap gap-2 p-2">
            {attachments.map((attachment) => (
              <AttachmentPreview
                actions={
                  <AttachmentAction
                    disabled={disabled || submitting || activeRunId !== null}
                    onClick={() => void handleRemove(attachment)}
                    type="button"
                  >
                    <XIcon />
                    <span className="sr-only">Remove {attachment.filename}</span>
                  </AttachmentAction>
                }
                attachment={attachment}
                key={attachment.id}
              />
            ))}
          </div>
        ) : null}
        <InputGroupTextarea
          aria-label={placeholder}
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          ref={textareaRef}
          rows={1}
          value={text}
        />
        <InputGroupAddon align="block-end" className="flex-wrap justify-between gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <ModelPicker
              disabled={disabled || activeRunId !== null}
              onChange={onSelectionChange}
              selection={selection}
              userId={userId}
            />
            {allowAttachments ? (
              <Button
                aria-label="Attach files"
                disabled={
                  disabled ||
                  queued > 0 ||
                  attachments.length >= ATTACHMENT_MESSAGE_MAX_FILES ||
                  activeRunId !== null
                }
                onClick={() => document.getElementById(`${draftKey}-files`)?.click()}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                {queued > 0 ? <Spinner className="size-4" /> : <PaperclipIcon className="size-4" />}
              </Button>
            ) : null}
            <input
              className="hidden"
              id={`${draftKey}-files`}
              multiple
              onChange={(event) => {
                void handleFiles(event.target.files);
                event.target.value = "";
              }}
              type="file"
            />
          </div>
          {activeRunId ? (
            <Button
              disabled={cancelling}
              onClick={onCancel}
              size="sm"
              type="button"
              variant="secondary"
            >
              <SquareIcon className="size-3.5" />
              {cancelling ? "Cancelling…" : "Stop"}
            </Button>
          ) : (
            <Button disabled={!canSubmit} onClick={submit} size="icon-sm" type="button">
              {submitting ? <Spinner className="size-4" /> : <ArrowUpIcon className="size-4" />}
              <span className="sr-only">{submittingLabel ?? "Send"}</span>
            </Button>
          )}
        </InputGroupAddon>
      </InputGroup>
      {uploadBlock === "image-thread-unsupported" ? (
        <p className="text-xs text-muted-foreground">
          This conversation has image attachments. Select a model that can use images to continue.
        </p>
      ) : null}
      {submitBlockedReason ? (
        <p className="text-xs text-muted-foreground">{submitBlockedReason}</p>
      ) : null}
      {error ? (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
      {uploadErrors.length > 0 ? (
        <div className="flex flex-col gap-1 text-xs text-destructive">
          <ul className="flex flex-col gap-1">
            {uploadErrors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
          <Button
            className="w-fit text-xs"
            onClick={() => setUploadErrors([])}
            size="sm"
            type="button"
            variant="ghost"
          >
            Dismiss
          </Button>
        </div>
      ) : null}
    </div>
  );
}
