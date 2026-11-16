/**
 * Path: protocol/src/attachments.ts
 * Used by: the @cloud-swe/protocol/attachments package export, protocol/src/{index,transcript}.ts.
 * Purpose: Image attachments: the upload and download route shapes and their limits. A message names uploads by ID.
 */

import { z } from 'zod';

import { AttachmentId, SessionId } from './primitives.ts';

/**
 * An image's bytes go inline into the Pi entry of the message that sends it, and one stored row holds at most 8 MB.
 * Base64 makes bytes a third larger, so three images of 1.5 MiB (6.3 MB) plus the longest text still fit one row,
 * and each stays under Pi's 4.5 MiB base64 ceiling for an image. The app shrinks an image before upload.
 */
export const ATTACHMENT_LIMITS = { bytes: 1_572_864, perMessage: 3 } as const;

// What the model takes inline (Pi's INLINE_IMAGE_TYPES). Open in responses: a newer server may serve more.
export const ImageMediaType = z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * PUT /v1/sessions/:sessionId/attachments/:attachmentId uploads the raw bytes as the body, with `Content-Type` one of
 * ImageMediaType; GET on the same path returns them with that type. The upload route has its own body limit,
 * `ATTACHMENT_LIMITS.bytes`, instead of the global 128 KiB. A retry with the same bytes returns the same attachment;
 * other bytes under the same ID are `operation_conflict`.
 */
export const AttachmentParams = z.strictObject({ sessionId: SessionId, attachmentId: AttachmentId });

// The upload's response: 201, or 200 when a retry finds it already stored.
export const Attachment = z.strictObject({
  id: AttachmentId,
  mediaType: ImageMediaType,
  bytes: z.int().positive().max(ATTACHMENT_LIMITS.bytes),
});

export type Attachment = z.infer<typeof Attachment>;

// The uploads a message sends, in the order the model sees them, after its text.
export const MessageAttachments = z
  .array(AttachmentId)
  .max(ATTACHMENT_LIMITS.perMessage)
  .refine((ids) => new Set(ids).size === ids.length, 'Attachments must be unique');
