import { z } from 'zod';

import { CommandIdentity, CommandRecord, OpenCommandRecord, OperationId, RunId, ToolCallId } from './index.ts';

// Transport/storage bounds, not copies of Pi's native tool parameter schemas.
export const ShellInput = z.strictObject({
  command: z.string().min(1).max(16_000),
  timeoutSeconds: z.number().positive().max(600),
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

export const BoatFileInfo = z.object({
  ok: z.literal(true),
  type: z.literal('file.info'),
  name: z.string(),
  path: z.string().min(1),
  isDir: z.boolean(),
  isSymlink: z.boolean(),
  size: z.number().int().nonnegative(),
  modifiedAt: z.iso.datetime({ offset: true }),
});

export const FileContent = z.strictObject({ content: z.string().max(400_000) });
export const FileBytes = z.strictObject({ content: z.string().max(1_398_104), encoding: z.literal('base64') });

export const DockerPath = z.strictObject({ path: z.string().min(1).max(4096) });

export const FileWritten = z.strictObject({ written: z.literal(true) });
export const CommandDispatched = z.strictObject({ started: z.literal(true) });
export const DockerCommand = z.strictObject({ command: z.string().min(1).max(100_000) });

export const DockerFileWrite = z.strictObject({
  path: z.string().min(1).max(4096),
  content: z.string().max(1_048_576),
});

export const BoatFileRead = z.object({
  ok: z.literal(true),
  type: z.literal('file.read'),
  success: z.literal(true),
  encoding: z.literal('utf8'),
  content: FileContent.shape.content,
});

export const BoatFileBytes = z.object({
  ok: z.literal(true),
  type: z.literal('file.read'),
  success: z.literal(true),
  encoding: z.literal('base64'),
  content: FileBytes.shape.content,
});

export const BoatFolderCreated = z.object({ ok: z.literal(true), type: z.literal('folder.created') });

export const BoatFileWritten = z.object({
  ok: z.literal(true),
  type: z.literal('file.written'),
  success: z.literal(true),
});

export const BoatCommandDispatched = z.object({
  ok: z.literal(true),
  type: z.literal('command.started'),
  success: z.literal(true),
});

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
