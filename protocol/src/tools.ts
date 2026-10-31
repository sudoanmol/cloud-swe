/**
 * Path: protocol/src/tools.ts
 * Used by: the @cloud-swe/protocol/tools package export.
 * Purpose: Tool wire formats: supervisor progress, durable command operations and sandbox file responses.
 */

import { z } from 'zod';

import { CommandIdentity, CommandRecord, OpenCommandRecord, OperationId, RunId, ToolCallId } from './index.ts';

// Transport/storage bounds, not copies of Pi's native tool parameter schemas.
export const ShellInput = z.strictObject({
  command: z.string().min(1).max(16_000),
  // Absent means the command runs until it exits. The bound is Node's setTimeout limit (~23 days).
  timeoutSeconds: z.number().positive().max(2_000_000).optional(),
  cwd: z.string().min(1).max(4096),
});

export type ShellInput = z.infer<typeof ShellInput>;

export const RemoteFileInfo = z.strictObject({
  name: z.string(),
  path: z.string().min(1),
  kind: z.enum(['file', 'directory', 'symlink']),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().finite(),
});

export const FileContent = z.strictObject({ content: z.string().max(400_000) });
export const FileBytes = z.strictObject({ content: z.string().max(6_990_508), encoding: z.literal('base64') });

export const FileWritten = z.strictObject({ written: z.literal(true) });
export const CommandDispatched = z.strictObject({ started: z.literal(true) });

const progress = {
  identity: CommandIdentity,
  output: z.string().max(64_000),
  outputBytes: z.number().int().nonnegative(),
};

export const ShellProgress = z.discriminatedUnion('kind', [
  z.strictObject({ ...progress, kind: z.literal('running'), heartbeat: z.int().nonnegative() }),
  z.strictObject({
    ...progress,
    kind: z.literal('exited'),
    exitCode: z.int(),
    termination: z.enum(['exit', 'cancelled', 'timeout']),
  }),
]);

export type ShellProgress = z.infer<typeof ShellProgress>;

// Private receipt, not a second Pi scheduler or a public shell endpoint.
export const CommandOperation = z.strictObject({
  record: CommandRecord,
  nativeTaskId: z.number().int().positive(),
  toolCallId: ToolCallId,
  parentToolCallId: ToolCallId.nullable().default(null),
  messageOperationId: OperationId,
  runId: RunId,
  intent: z.string().max(100_000),
});

export type CommandOperation = z.infer<typeof CommandOperation>;

export const OpenCommandOperation = CommandOperation.extend({ record: OpenCommandRecord });

export type OpenCommandOperation = z.infer<typeof OpenCommandOperation>;
