/**
 * Path: protocol/src/primitives.ts
 * Used by: protocol/src/{environments,git,index,interaction}.ts.
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

// Shared with the native parsers, so an oversized name never parses natively and then fails here.
export const ToolName = z.string().min(1).max(256);
