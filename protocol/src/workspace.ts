import { z } from 'zod';

import { WorkspaceId } from './index.ts';

export const DockerWorkspaceInfo = z.strictObject({
  provider: z.literal('docker'),
  id: WorkspaceId,
  state: z.literal('running'),
  root: z.string().regex(/^\/workspace\/[0-9a-f-]{36}$/),
});

const BoatSandboxId = z.string().regex(/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);

// Only the error code is used to decide whether an idempotent create is still in progress.
export const BoatApiError = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string().min(1) }),
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
    access: z.enum(['owner', 'use', 'view']).optional(),
  }),
});
