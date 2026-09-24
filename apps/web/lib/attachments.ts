import {
  ATTACHMENT_FILE_MAX_BYTES,
  ATTACHMENT_MESSAGE_MAX_BYTES,
  ATTACHMENT_MESSAGE_MAX_FILES,
} from "@cloud-swe/db/attachment-limits";

/** Uploads run in pairs so a large selection does not open ten connections. */
export const MAX_CONCURRENT_UPLOADS = 2;

export type AttachmentRejectionReason =
  | "count-limit"
  | "file-too-large"
  | "images-unsupported"
  | "message-too-large";

export type AttachmentRejection = { filename: string; reason: AttachmentRejectionReason };

/** The only file facts the limits depend on, so the policy is trivially testable. */
export type AttachmentCandidate = { name: string; size: number; type: string };

export type AttachmentPlan<Selected extends AttachmentCandidate> = {
  accepted: Selected[];
  rejected: AttachmentRejection[];
};

export function isImageFile(file: AttachmentCandidate): boolean {
  return file.type.startsWith("image/");
}

/**
 * A thread that already contains images can only be continued by a model that
 * accepts images; for every other model even a text-only follow-up is blocked.
 */
export function submissionBlockReason(input: {
  supportsImages: boolean;
  hasThreadImages: boolean;
}): "image-thread-unsupported" | null {
  return input.hasThreadImages && !input.supportsImages ? "image-thread-unsupported" : null;
}

/**
 * Applies the same limits the backend enforces, before anything is uploaded.
 * `alreadyQueued` counts selections that are still uploading and `accepted` the
 * ones already attached, so overlapping picks cannot together exceed the quota.
 */
export function planAttachments<Selected extends AttachmentCandidate>(input: {
  incoming: readonly Selected[];
  accepted: readonly AttachmentCandidate[];
  alreadyQueued: number;
  /** Bytes the attachments already on the message occupy. */
  usedBytes?: number;
  /** Whether the selected model accepts image input. */
  supportsImages: boolean;
}): AttachmentPlan<Selected> {
  const accepted: Selected[] = [];
  const rejected: AttachmentRejection[] = [];

  const messageLimit = ATTACHMENT_MESSAGE_MAX_FILES - input.alreadyQueued - input.accepted.length;

  let bytes = input.usedBytes ?? 0;

  for (const file of input.accepted) bytes += file.size;

  for (const file of input.incoming) {
    // Only the model decides: an image-capable model may add images even to a
    // thread that already contains some.
    if (isImageFile(file) && !input.supportsImages) {
      rejected.push({ filename: file.name, reason: "images-unsupported" });

      continue;
    }

    if (file.size > ATTACHMENT_FILE_MAX_BYTES) {
      rejected.push({ filename: file.name, reason: "file-too-large" });

      continue;
    }

    if (accepted.length >= messageLimit) {
      rejected.push({ filename: file.name, reason: "count-limit" });

      continue;
    }

    if (bytes + file.size > ATTACHMENT_MESSAGE_MAX_BYTES) {
      rejected.push({ filename: file.name, reason: "message-too-large" });

      continue;
    }

    accepted.push(file);
    bytes += file.size;
  }

  return { accepted, rejected };
}

/** The outcome of one upload, tagged so a rejection cannot read as success. */
export type UploadOutcome<Result> = { file: File } & PromiseSettledResult<Result>;

/**
 * Uploads with a bounded number of requests in flight. The returned array is
 * aligned with `files`, so callers can attach results in selection order even
 * when the requests finish out of order.
 */
export async function uploadWithConcurrency<Result>(
  files: readonly File[],
  limit: number,
  upload: (file: File) => Promise<Result>,
): Promise<UploadOutcome<Result>[]> {
  const outcomes: UploadOutcome<Result>[] = Array.from({ length: files.length });
  let next = 0;

  const worker = async () => {
    while (next < files.length) {
      const index = next;

      next += 1;

      const file = files[index];

      if (!file) continue;

      try {
        outcomes[index] = { file, status: "fulfilled", value: await upload(file) };
      } catch (error) {
        outcomes[index] = { file, reason: error, status: "rejected" };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, files.length)) }, () => worker()),
  );

  return outcomes;
}

export function attachmentRejectionMessage(rejection: AttachmentRejection): string {
  const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

  switch (rejection.reason) {
    case "count-limit":
      return `${rejection.filename}: at most ${ATTACHMENT_MESSAGE_MAX_FILES} attachments per message.`;
    case "file-too-large":
      return `${rejection.filename}: files must be at most ${megabytes(ATTACHMENT_FILE_MAX_BYTES)}.`;
    case "images-unsupported":
      return `${rejection.filename}: this model cannot use image attachments.`;
    case "message-too-large":
      return `${rejection.filename}: attachments must total at most ${megabytes(ATTACHMENT_MESSAGE_MAX_BYTES)}.`;
  }
}
