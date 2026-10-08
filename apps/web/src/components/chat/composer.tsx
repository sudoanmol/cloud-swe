import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon, ArrowUpIcon, PaperclipIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type Ref, type RefObject } from "react";

import { AttachmentAction } from "@/components/ui/attachment";
import { AttachmentPreview } from "@/components/chat/attachment-preview";
import { submissionBlockReason } from "@/lib/attachments";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { ATTACHMENT_MESSAGE_MAX_FILES } from "@cloud-swe/db/attachment-limits";
import type { PublicAttachmentMetadata } from "@cloud-swe/api/contracts";
import type { ModelCatalogEntry, ModelSelection } from "@cloud-swe/db/model-contracts";
import { readDraft, writeDraft } from "@/lib/drafts";
import { providerModelsQueryOptions } from "@/lib/queries";
import type { RepositorySelection } from "@/lib/repository-selection";
import { cn } from "@/lib/utils";
import { useComposerAttachments } from "@/hooks/use-composer-attachments";

import { insertMention, mentionAt } from "@/lib/mentions";
import { MentionPicker, type MentionPickerHandle, type MentionSelection } from "./mention-picker";
import { ModelPicker, RepositoryPicker } from "./pickers";
import { Context, ContextContent, ContextTrigger } from "@/components/ai-elements/context";
import type { ThreadUsage } from "@/lib/chat-types";

/** Every rule the composer advertises comes from the shared attachment limits. */

function canSubmitMessage(composer: {
  selection: ModelSelection | null;
  uploadBlock: ReturnType<typeof submissionBlockReason>;
  disabled: boolean;
  submitting: boolean;
  queued: number;
  submitBlockedReason: string | null;
  repository: { value: RepositorySelection | null | undefined } | undefined;
  activeRunId: string | null;
  hasContent: boolean;
}): boolean {
  return (
    composer.selection !== null &&
    composer.uploadBlock === null &&
    // A missing selection would make Send a no-op while the catalogs load.
    !composer.disabled &&
    !composer.submitting &&
    // Uploads must settle first: an id that is still uploading cannot be sent.
    composer.queued === 0 &&
    composer.submitBlockedReason === null &&
    // A new thread waits for its repository to resolve; follow-ups have none.
    (composer.repository === undefined || composer.repository.value !== undefined) &&
    composer.activeRunId === null &&
    composer.hasContent
  );
}

function useSelectedModel(
  userId: string,
  selection: ModelSelection | null,
  supportsImagesOverride: boolean | undefined,
) {
  const catalog = useQuery({
    ...providerModelsQueryOptions(userId, selection?.provider ?? "vercel-ai-gateway"),
    enabled: selection !== null,
  });

  const selectedModel = catalog.data?.models.find((entry) => entry.id === selection?.model);

  return {
    selectedModel,
    supportsImages: supportsImagesOverride ?? selectedModel?.input.includes("image") ?? false,
  };
}

/** The `@`/`$` mention state of the composer textarea and the picker that edits it. */
function useMentionInput(text: string, setText: (text: string) => void) {
  const [mention, setMention] = useState<ReturnType<typeof mentionAt>>(null);
  const [activeMention, setActiveMention] = useState<MentionSelection>();
  const mentionRef = useRef<MentionPickerHandle>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Phones would pop the keyboard over the transcript, so only focus on desktop.
  useEffect(() => {
    if (window.matchMedia("(min-width: 768px)").matches) textareaRef.current?.focus();
  }, []);

  const selectMention = (value: string) => {
    if (!mention) return;
    const next = insertMention(text, mention, value);
    setText(next.text);
    setMention(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  return {
    mention,
    setMention,
    activeMention,
    setActiveMention,
    mentionRef,
    textareaRef,
    selectMention,
  };
}

function ContextMeter({
  model,
  usage,
}: {
  model: ModelCatalogEntry | undefined;
  usage: ThreadUsage | null;
}) {
  if (!usage || !model) return null;

  return (
    <Context maxTokens={model.contextWindow} usage={usage}>
      <ContextTrigger className="h-7 px-2" />
      <ContextContent align="end" side="top" />
    </Context>
  );
}

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
  usage = null,
  mentionThread,
}: {
  mentionThread?: { id: string; running: boolean; repository: RepositorySelection | null };
  userId: string;
  draftKey: string;
  selection: ModelSelection | null;
  onSelectionChange: (selection: ModelSelection) => void;
  repository?: {
    /** `undefined` while the picker is still restoring or choosing a repository. */
    value: RepositorySelection | null | undefined;
    onChange: (value: RepositorySelection | null) => void;
  };
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
  const [text, setText] = useState(() => readDraft(userId, draftKey));

  const {
    mention,
    setMention,
    setActiveMention,
    activeMention,
    mentionRef,
    textareaRef,
    selectMention,
  } = useMentionInput(text, setText);

  const { selectedModel, supportsImages } = useSelectedModel(userId, selection, supportsImagesProp);

  const { attachments, uploadErrors, clearUploadErrors, queued, handleFiles, handleRemove } =
    useComposerAttachments(userId, supportsImages);

  useEffect(() => {
    writeDraft(userId, draftKey, text);
  }, [draftKey, text, userId]);

  const hasContent = text.trim().length > 0 || attachments.length > 0;

  // The backend's classification is authoritative: a file whose browser type is
  // generic can still be an image the model must be able to read.
  const threadHasImages =
    hasThreadImages || attachments.some((attachment) => attachment.classification === "image");

  const uploadBlock = submissionBlockReason({ hasThreadImages: threadHasImages, supportsImages });

  const canSubmit = canSubmitMessage({
    selection,
    uploadBlock,
    disabled,
    submitting,
    queued,
    submitBlockedReason,
    repository,
    activeRunId,
    hasContent,
  });

  // Picking a model or repository, or editing attachments, waits for the run to settle.
  const locked = disabled || activeRunId !== null;

  const submit = () => {
    if (!canSubmit) return;

    onSubmit({
      text: text.trim(),
      attachments,
    });
  };

  return (
    <div className="relative flex w-full flex-col gap-2">
      {mention ? (
        <MentionPicker
          userId={userId}
          thread={mentionThread}
          repository={mentionThread?.repository ?? repository?.value}
          query={mention.query}
          group={mention.group}
          ref={mentionRef}
          onInsert={selectMention}
          onClose={() => setMention(null)}
          onActiveChange={setActiveMention}
        />
      ) : null}
      {repository ? (
        <RepositoryRow
          locked={locked}
          onChange={repository.onChange}
          userId={userId}
          value={repository.value}
        />
      ) : null}
      <div className="[&>div]:rounded-2xl [&>div]:border [&>div]:border-border/30 [&>div]:bg-card/70 [&>div]:shadow-[var(--shadow-composer)] [&>div]:transition-shadow [&>div]:duration-300 [&>div]:focus-within:shadow-[var(--shadow-composer-focus)]">
        <InputGroup className="overflow-hidden">
          <AttachmentStrip
            attachments={attachments}
            locked={locked || submitting}
            onRemove={(attachment) => void handleRemove(attachment)}
          />
          <ComposerTextarea
            activeMention={activeMention}
            disabled={disabled}
            mention={mention}
            mentionRef={mentionRef}
            onMentionChange={setMention}
            onSubmit={submit}
            onTextChange={setText}
            placeholder={placeholder}
            ref={textareaRef}
            text={text}
          />
          <InputGroupAddon align="block-end" className="justify-between gap-1 px-3 pb-3">
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              {allowAttachments ? (
                <AttachControl
                  disabled={
                    locked || queued > 0 || attachments.length >= ATTACHMENT_MESSAGE_MAX_FILES
                  }
                  inputId={`${draftKey}-files`}
                  onFiles={(files) => void handleFiles(files)}
                  uploading={queued > 0}
                />
              ) : null}
              <ModelPicker
                disabled={locked}
                onChange={onSelectionChange}
                selection={selection}
                userId={userId}
              />
            </div>
            <div className="flex items-center gap-1">
              <ContextMeter model={selectedModel} usage={usage} />
              <RunButton
                activeRunId={activeRunId}
                cancelling={cancelling}
                canSubmit={canSubmit}
                onCancel={onCancel}
                onSubmit={submit}
                submitting={submitting}
                submittingLabel={submittingLabel}
              />
            </div>
          </InputGroupAddon>
        </InputGroup>
      </div>
      <ComposerNotices
        error={error}
        onDismissUploadErrors={clearUploadErrors}
        submitBlockedReason={submitBlockedReason}
        uploadBlock={uploadBlock}
        uploadErrors={uploadErrors}
      />
    </div>
  );
}

function AttachmentStrip({
  attachments,
  locked,
  onRemove,
}: {
  attachments: readonly PublicAttachmentMetadata[];
  locked: boolean;
  onRemove: (attachment: PublicAttachmentMetadata) => void;
}) {
  if (attachments.length === 0) return null;

  return (
    <div className="no-scrollbar flex w-full flex-row gap-2 self-start overflow-x-auto px-3 pt-3">
      {attachments.map((attachment) => (
        <AttachmentPreview
          actions={
            <AttachmentAction disabled={locked} onClick={() => onRemove(attachment)} type="button">
              <XIcon />
              <span className="sr-only">Remove {attachment.filename}</span>
            </AttachmentAction>
          }
          attachment={attachment}
          key={attachment.id}
        />
      ))}
    </div>
  );
}

function AttachControl({
  disabled,
  uploading,
  inputId,
  onFiles,
}: {
  disabled: boolean;
  uploading: boolean;
  inputId: string;
  onFiles: (files: FileList | null) => void;
}) {
  return (
    <>
      <Button
        aria-label="Attach files"
        className="h-7 w-7 rounded-lg border border-border/40 p-1 text-foreground transition-colors hover:border-border hover:text-foreground disabled:cursor-not-allowed disabled:text-muted-foreground/30"
        disabled={disabled}
        onClick={() => document.getElementById(inputId)?.click()}
        type="button"
        variant="ghost"
      >
        {uploading ? <Spinner className="size-3.5" /> : <PaperclipIcon className="size-3.5" />}
      </Button>
      <input
        className="hidden"
        id={inputId}
        multiple
        onChange={(event) => {
          onFiles(event.target.files);
          event.target.value = "";
        }}
        type="file"
      />
    </>
  );
}

/** Stop while a run is active, otherwise send. */
function RunButton({
  activeRunId,
  cancelling,
  canSubmit,
  submitting,
  submittingLabel,
  onCancel,
  onSubmit,
}: {
  activeRunId: string | null;
  cancelling: boolean;
  canSubmit: boolean;
  submitting: boolean;
  submittingLabel?: string;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  if (activeRunId)
    return (
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
    );

  return (
    <Button
      className={cn(
        "h-7 w-7 rounded-xl transition-all duration-200",
        canSubmit
          ? "bg-foreground text-background hover:bg-foreground hover:opacity-85 active:scale-95"
          : "cursor-not-allowed bg-muted text-muted-foreground/25",
      )}
      data-testid="send-button"
      disabled={!canSubmit}
      onClick={onSubmit}
      type="button"
      variant="secondary"
    >
      {submitting ? <Spinner className="size-4" /> : <ArrowUpIcon className="size-4" />}
      <span className="sr-only">{submittingLabel ?? "Send"}</span>
    </Button>
  );
}

function ComposerNotices({
  uploadBlock,
  submitBlockedReason,
  error,
  uploadErrors,
  onDismissUploadErrors,
}: {
  uploadBlock: ReturnType<typeof submissionBlockReason>;
  submitBlockedReason: string | null;
  error: string | null;
  uploadErrors: readonly string[];
  onDismissUploadErrors: () => void;
}) {
  return (
    <>
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
            onClick={onDismissUploadErrors}
            size="sm"
            type="button"
            variant="ghost"
          >
            Dismiss
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** A combobox over the mention picker: the picker handles keys while it is open. */
function ComposerTextarea({
  text,
  placeholder,
  disabled,
  mention,
  activeMention,
  mentionRef,
  onTextChange,
  onMentionChange,
  onSubmit,
  ref,
}: {
  text: string;
  placeholder: string;
  disabled: boolean;
  mention: ReturnType<typeof mentionAt>;
  activeMention: MentionSelection | undefined;
  mentionRef: RefObject<MentionPickerHandle | null>;
  onTextChange: (text: string) => void;
  onMentionChange: (mention: ReturnType<typeof mentionAt>) => void;
  onSubmit: () => void;
  ref: Ref<HTMLTextAreaElement>;
}) {
  return (
    <InputGroupTextarea
      aria-label={placeholder}
      className="field-sizing-content max-h-48 min-h-24 px-4 pt-3.5 pb-1.5 text-[13px] leading-relaxed placeholder:text-muted-foreground/35"
      disabled={disabled}
      role="combobox"
      aria-haspopup="listbox"
      aria-activedescendant={mention ? activeMention?.itemId : undefined}
      aria-expanded={mention !== null}
      aria-controls={mention ? activeMention?.listId : undefined}
      aria-autocomplete="list"
      onBlur={() => onMentionChange(null)}
      onClick={(event) => onMentionChange(mentionAt(text, event.currentTarget.selectionStart))}
      onChange={(event) => {
        onTextChange(event.target.value);
        onMentionChange(mentionAt(event.target.value, event.target.selectionStart));
      }}
      onKeyUp={(event) => {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          onMentionChange(mentionAt(text, event.currentTarget.selectionStart));
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;

        if (mention && mentionRef.current?.keyDown(event.key)) {
          event.preventDefault();

          return;
        }

        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onSubmit();
        }
      }}
      placeholder={placeholder}
      ref={ref}
      value={text}
    />
  );
}

function RepositoryRow({
  locked,
  userId,
  value,
  onChange,
}: {
  locked: boolean;
  userId: string;
  value: RepositorySelection | null | undefined;
  onChange: (value: RepositorySelection | null) => void;
}) {
  return (
    <div className="flex min-w-0 items-center rounded-xl border border-border/30 bg-card/40 px-1.5 py-1">
      <RepositoryPicker disabled={locked} onChange={onChange} userId={userId} value={value} />
    </div>
  );
}
