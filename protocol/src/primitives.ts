/**
 * Path: protocol/src/primitives.ts
 * Used by: protocol/src/{attachments,environments,index,interaction,transcript}.ts.
 * Purpose: The ID, name and timestamp schemas every other protocol file builds on. Standalone so no file has to import index.ts for them.
 */

import { z } from 'zod';

export const SessionId = z.uuid().brand<'SessionId'>();
export const OperationId = z.uuid().brand<'OperationId'>();
export const RunId = z.uuid().brand<'RunId'>();
export const WorkspaceId = z.uuid().brand<'WorkspaceId'>();
export const EntryId = z.string().min(1).max(256).brand<'EntryId'>();
export const ToolCallId = z.string().min(1).max(256).brand<'ToolCallId'>();
export const Timestamp = z.iso.datetime();
export const Cursor = z.string().min(1).max(512).brand<'Cursor'>();

// One conversation in a session: Pi's own conversation ID as a decimal string (the root is "1"). Pi never reuses or
// deletes one, so it is a stable address within its session. Opaque to clients, who only compare and send it back.
export const ConversationId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .brand<'ConversationId'>();

// An uploaded image, named by the client before upload like an operation ID, so a retried upload is the same one.
export const AttachmentId = z.uuid().brand<'AttachmentId'>();

// Shared with the native parsers, so an oversized name never parses natively and then fails here.
export const ToolName = z.string().min(1).max(256);
