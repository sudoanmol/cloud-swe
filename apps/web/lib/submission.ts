import { z } from "zod";

import { modelSelectionSchema } from "@cloud-swe/db/model-contracts";

/**
 * A submission envelope is frozen before the request leaves the browser:
 * identical retries reuse the exact same `clientMessageId` and body so the
 * backend's idempotency lookup can return the original accepted result.
 */
export const submissionEnvelopeSchema = z
  .object({
    clientMessageId: z.string().min(1).max(255),
    prompt: z.string(),
    attachmentIds: z.array(z.uuid()).max(10),
    modelSelection: modelSelectionSchema,
    repositoryUrl: z.string().min(1).max(2_048).optional(),
    branch: z.string().min(1).max(255).optional(),
    threadId: z.uuid().optional(),
  })
  .strict();

export type SubmissionEnvelope = z.infer<typeof submissionEnvelopeSchema>;

export type SubmissionState =
  | { status: "idle" }
  | { status: "pending"; envelope: SubmissionEnvelope }
  | { status: "accepted"; envelope: SubmissionEnvelope; threadId: string; runId: string }
  /** The request may or may not have been accepted; the envelope is retried as-is. */
  | { status: "uncertain"; envelope: SubmissionEnvelope };

export function createEnvelope(input: {
  prompt: string;
  attachmentIds: readonly string[];
  modelSelection: SubmissionEnvelope["modelSelection"];
  repositoryUrl?: string | undefined;
  branch?: string | undefined;
  threadId?: string | undefined;
}): SubmissionEnvelope {
  const envelope: SubmissionEnvelope = {
    attachmentIds: [...input.attachmentIds],
    clientMessageId: crypto.randomUUID(),
    modelSelection: input.modelSelection,
    prompt: input.prompt,
  };

  if (input.repositoryUrl !== undefined) envelope.repositoryUrl = input.repositoryUrl;

  if (input.branch !== undefined) envelope.branch = input.branch;

  if (input.threadId !== undefined) envelope.threadId = input.threadId;

  return submissionEnvelopeSchema.parse(envelope);
}

/** Fields the thread submission routes accept, owned here so retries stay byte identical. */
export type ThreadSubmissionBody = {
  clientMessageId: string;
  prompt: string;
  modelSelection: SubmissionEnvelope["modelSelection"];
  attachmentIds?: string[];
  repositoryUrl?: string;
  branch?: string;
};

/** The exact request body for an envelope. Retries reuse it byte for byte. */
export type SubmissionRequest = { path: string; body: ThreadSubmissionBody };

export function submissionBody(envelope: SubmissionEnvelope): SubmissionRequest {
  const body: ThreadSubmissionBody = {
    clientMessageId: envelope.clientMessageId,
    modelSelection: envelope.modelSelection,
    prompt: envelope.prompt,
  };

  if (envelope.attachmentIds.length > 0) body.attachmentIds = envelope.attachmentIds;

  if (envelope.threadId) return { body, path: `/api/threads/${envelope.threadId}/messages` };

  if (envelope.repositoryUrl) body.repositoryUrl = envelope.repositoryUrl;

  if (envelope.branch) body.branch = envelope.branch;

  return { body, path: "/api/threads" };
}

const STORAGE_PREFIX = "cloud-swe:submission";

function storageKey(userId: string, threadId: string | undefined): string {
  return `${STORAGE_PREFIX}:${userId}:${threadId ?? "new"}`;
}

/**
 * Only a pending/uncertain envelope survives a reload, and only for the account
 * that created it. Serialization is validated when read back.
 */
export function saveEnvelope(
  storage: Pick<Storage, "setItem" | "removeItem">,
  userId: string,
  envelope: SubmissionEnvelope,
): void {
  storage.setItem(storageKey(userId, envelope.threadId), JSON.stringify(envelope));
}

export function clearEnvelope(
  storage: Pick<Storage, "setItem" | "removeItem">,
  userId: string,
  threadId: string | undefined,
): void {
  storage.removeItem(storageKey(userId, threadId));
}

export function loadEnvelope(
  storage: Pick<Storage, "getItem">,
  userId: string,
  threadId: string | undefined,
): SubmissionEnvelope | null {
  const raw = storage.getItem(storageKey(userId, threadId));

  if (!raw) return null;

  try {
    const parsed = submissionEnvelopeSchema.safeParse(JSON.parse(raw));

    return parsed.success && parsed.data.threadId === threadId ? parsed.data : null;
  } catch {
    return null;
  }
}
