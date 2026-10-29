import { z } from 'zod';

export const DockerWorkspaceInfo = z.strictObject({
  provider: z.literal('docker'),
  state: z.literal('running'),
  root: z.literal('/workspace'),
});

// Only the fields consumed from Boat's documented sandbox.info envelope.
export const BoatWorkspaceInfo = z.object({
  ok: z.literal(true),
  type: z.literal('sandbox.info'),
  sandbox: z.object({
    id: z.string().regex(/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/),
    state: z.enum(['init', 'provisioning', 'provisioned', 'cloning', 'ready', 'idle', 'running', 'archiving', 'archived', 'error', 'cancelled']),
    health: z.enum(['ok', 'degraded']).optional(),
    access: z.enum(['owner', 'use', 'view']).optional(),
  }),
});
