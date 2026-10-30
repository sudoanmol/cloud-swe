/**
 * Path: server/src/workspaces/boat-schemas.ts
 * Used by: server/src/workspaces/boat.ts, server/src/tools/remote.ts.
 * Purpose: Boat upstream response schemas; only the fields the adapters consume. Clients never see these.
 */
import { FileContent, FileBytes } from '@cloud-swe/protocol/tools';
import { z } from 'zod';

const BoatSandboxId = z.string().regex(/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);

// Only the error code is used to decide whether an idempotent create is still in progress.
export const BoatApiError = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string().min(1), message: z.string().optional() }),
});

// Only the fields consumed from Boat's documented sandbox.created envelope.
export const BoatSandboxCreated = z.object({
  ok: z.literal(true),
  type: z.literal('sandbox.created'),
  sandbox: z.object({ id: BoatSandboxId }),
});

// Recovery must see a complete result set before treating a missing sandbox as absent.
export const BoatSandboxList = z.object({
  ok: z.literal(true),
  type: z.literal('sandbox.list'),
  sandboxes: z.array(z.object({ id: BoatSandboxId, name: z.string().min(1) })).max(2),
  pageInfo: z.object({ hasMore: z.boolean() }),
});

// Only the fields consumed from Boat's documented sandbox.info envelope.
export const BoatWorkspaceInfo = z.object({
  ok: z.literal(true),
  type: z.literal('sandbox.info'),
  sandbox: z.object({
    id: BoatSandboxId,
    state: z.enum([
      'init',
      'provisioning',
      'provisioned',
      'cloning',
      'ready',
      'idle',
      'running',
      'archiving',
      'archived',
      'error',
      'cancelled',
    ]),
    health: z.enum(['ok', 'degraded']).optional(),
    // Set once Boat deleted a stopped sandbox's saved disk (14 days after it stopped); resume then fails.
    dataExpiredAt: z.date().nullish(),
    access: z.enum(['owner', 'use', 'view']).optional(),
  }),
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
