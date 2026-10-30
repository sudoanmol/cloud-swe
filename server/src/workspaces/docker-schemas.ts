/**
 * Path: server/src/workspaces/docker-schemas.ts
 * Used by: server/src/workspaces/docker.ts, server/test/{sandbox,sandbox-tools}.ts.
 * Purpose: Docker test-sandbox service request and response schemas; clients never see these.
 */
import { WorkspaceId } from '@cloud-swe/protocol';
import { z } from 'zod';

export const DockerWorkspaceInfo = z.strictObject({
  provider: z.literal('docker'),
  id: WorkspaceId,
  state: z.enum(['running', 'starting', 'stopped']),
  root: z.string().regex(/^\/workspace\/[0-9a-f-]{36}$/),
});

export const DockerPath = z.strictObject({ path: z.string().min(1).max(4096) });

export const DockerCommand = z.strictObject({ command: z.string().min(1).max(100_000) });

export const DockerFileWrite = z.strictObject({
  path: z.string().min(1).max(4096),
  content: z.string().max(1_048_576),
});

export const DockerTtl = z.strictObject({ ttlSeconds: z.number().int().positive() });

export type DockerTtl = z.infer<typeof DockerTtl>;
