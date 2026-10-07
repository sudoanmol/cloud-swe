import { useMutation, useQuery } from "@tanstack/react-query";
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
import type { RepositorySelection } from "@/lib/repository-selection";
import { messageForError } from "@/lib/submission-errors";
import { cn } from "@/lib/utils";

import { EnvironmentPicker } from "./environment-picker";
import { ModelPicker, RepositoryPicker } from "./pickers";
import { Context, ContextContent, ContextTrigger } from "@/components/ai-elements/context";
import type { ThreadUsage } from "@/lib/chat-types";

/** Every rule the composer advertises comes from the shared attachment limits. */

/** One composer for a new thread and for follow-ups. */
export function Composer({
  userId,
  draftKey,
  selection,
  onSelectionChange,
  repository,
  environment,
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
  usage = null,
}: {
  userId: string;
  draftKey: string;
  selection: ModelSelection | null;
  onSelectionChange: (selection: ModelSelection) => void;
  repository?: {
    /** `undefined` while the picker is still restoring or choosing a repository. */
    value: RepositorySelection | null | undefined;
    onChange: (value: RepositorySelection | null) => void;
  };
  /** New threads only: the environment the thread is pinned to. */
  environment?: { value: string | null; onChange: (value: string | null) => void };
  onSubmit: (input: { text: string; attachments: PublicAttachmentMetadata[] }) => void;
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
  /** The thread's token usage; the context meter measures it against the selected model. */
  usage?: ThreadUsage | null;
}) {
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

  // Phones would pop the keyboard over the transcript, so only focus on desktop.
  useEffect(() => {
    if (window.matchMedia("(min-width: 768px)").matches) textareaRef.current?.focus();
  }, []);

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
    // A new thread waits for its repository to resolve; follow-ups have none.
    (repository === undefined || repository.value !== undefined) &&
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
    }
  };

  const submit = () => {
    if (!canSubmit) return;

    onSubmit({
      text: text.trim(),
      attachments,
    });
  };

  return (
    <div className="relative flex w-full flex-col gap-2">
      {repository ? (
        <div className="flex min-w-0 items-center rounded-xl border border-border/30 bg-card/40 px-1.5 py-1">
          <RepositoryPicker
            disabled={disabled || activeRunId !== null}
            onChange={repository.onChange}
            userId={userId}
            value={repository.value}
          />
          {environment ? (
            <EnvironmentPicker
              disabled={disabled || activeRunId !== null}
              onChange={environment.onChange}
              userId={userId}
              value={environment.value}
            />
          ) : null}
        </div>
      ) : null}
      <div className="[&>div]:rounded-2xl [&>div]:border [&>div]:border-border/30 [&>div]:bg-card/70 [&>div]:shadow-[var(--shadow-composer)] [&>div]:transition-shadow [&>div]:duration-300 [&>div]:focus-within:shadow-[var(--shadow-composer-focus)]">
        <InputGroup className="overflow-hidden">
          {attachments.length > 0 ? (
            <div className="no-scrollbar flex w-full flex-row gap-2 self-start overflow-x-auto px-3 pt-3">
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
            className="field-sizing-content max-h-48 min-h-24 px-4 pt-3.5 pb-1.5 text-[13px] leading-relaxed placeholder:text-muted-foreground/35"
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
            value={text}
          />
          <InputGroupAddon align="block-end" className="justify-between gap-1 px-3 pb-3">
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              {allowAttachments ? (
                <Button
                  aria-label="Attach files"
                  className="h-7 w-7 rounded-lg border border-border/40 p-1 text-foreground transition-colors hover:border-border hover:text-foreground disabled:cursor-not-allowed disabled:text-muted-foreground/30"
                  disabled={
                    disabled ||
                    queued > 0 ||
                    attachments.length >= ATTACHMENT_MESSAGE_MAX_FILES ||
                    activeRunId !== null
                  }
                  onClick={() => document.getElementById(`${draftKey}-files`)?.click()}
                  type="button"
                  variant="ghost"
                >
                  {queued > 0 ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <PaperclipIcon className="size-3.5" />
                  )}
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
              <ModelPicker
                disabled={disabled || activeRunId !== null}
                onChange={onSelectionChange}
                selection={selection}
                userId={userId}
              />
            </div>
            <div className="flex items-center gap-1">
              {usage && selectedModel ? (
                <Context maxTokens={selectedModel.contextWindow} usage={usage}>
                  <ContextTrigger className="h-7 px-2" />
                  <ContextContent align="end" side="top" />
                </Context>
              ) : null}
              {activeRunId ? (
                <Button
                  className="h-7 w-7 rounded-xl bg-foreground p-1 text-background transition-all duration-200 hover:bg-foreground hover:opacity-85 active:scale-95 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground/25"
                  data-testid="stop-button"
                  disabled={cancelling}
                  onClick={onCancel}
                  type="button"
                >
                  {cancelling ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <SquareIcon className="size-3 fill-current" />
                  )}
                  <span className="sr-only">{cancelling ? "Cancelling…" : "Stop"}</span>
                </Button>
              ) : (
                <Button
                  className={cn(
                    "h-7 w-7 rounded-xl transition-all duration-200",
                    canSubmit
                      ? "bg-foreground text-background hover:bg-foreground hover:opacity-85 active:scale-95"
                      : "cursor-not-allowed bg-muted text-muted-foreground/25",
                  )}
                  data-testid="send-button"
                  disabled={!canSubmit}
                  onClick={submit}
                  type="button"
                  variant="secondary"
                >
                  {submitting ? <Spinner className="size-4" /> : <ArrowUpIcon className="size-4" />}
                  <span className="sr-only">{submittingLabel ?? "Send"}</span>
                </Button>
              )}
            </div>
          </InputGroupAddon>
        </InputGroup>
      </div>
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
