/**
 * Path: protocol/src/attachments.ts
 * Used by: the @cloud-swe/protocol/attachments package export, protocol/src/{index,native,storage,transcript}.ts.
 * Purpose: Image attachments: the upload and download route shapes and their limits. A message names uploads by ID.
 */

import { z } from 'zod';

import { AttachmentId, SessionId } from './primitives.ts';

/**
 * Each attachment has two files, both made by the app. The model copy is what the model sees, at most `modelEdge`
 * pixels on its long edge: Anthropic downscales past that anyway, and refuses a larger one once a request holds more
 * than 20 images, which would break every later request of the conversation. The original is for the owner to view.
 */
export const ATTACHMENT_LIMITS = {
  modelBytes: 5 * 1024 * 1024,
  modelEdge: 2576,
  originalBytes: 20 * 1024 * 1024,
  perMessage: 5,
} as const;

// What the model takes (Pi's INLINE_IMAGE_TYPES). Open in responses: a newer server may serve more.
export const ImageMediaType = z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * PUT /v1/sessions/:sessionId/attachments/:attachmentId uploads the model copy's raw bytes as the body, with
 * `Content-Type` one of ImageMediaType; GET on the same path returns them with that type. PUT and GET on
 * `…/:attachmentId/original` do the same for the optional original. Each route has its own body limit instead of the
 * global 128 KiB. A retry with the same bytes returns the same attachment; other bytes under the same ID are
 * `operation_conflict`.
 */
export const AttachmentParams = z.strictObject({ sessionId: SessionId, attachmentId: AttachmentId });

// The upload's response: 201, or 200 when a retry finds it already stored.
export const Attachment = z.strictObject({
  id: AttachmentId,
  mediaType: ImageMediaType,
  bytes: z.int().positive().max(ATTACHMENT_LIMITS.originalBytes),
});

export type Attachment = z.infer<typeof Attachment>;

// The uploads a message sends, in the order the model sees them, after its text. Each needs its model copy.
export const MessageAttachments = z
  .array(AttachmentId)
  .max(ATTACHMENT_LIMITS.perMessage)
  .refine((ids) => new Set(ids).size === ids.length, 'Attachments must be unique');
