/**
 * Path: protocol/src/credentials.ts
 * Used by: the @cloud-swe/protocol/credentials package export.
 * Purpose: Model credential and Git identity schemas. Keys are write-only.
 */

import { z } from 'zod';

export const ModelProvider = z.literal('anthropic');
export const ModelCredentialParams = z.strictObject({ provider: ModelProvider });
export const SetModelCredentialRequest = z.strictObject({ key: z.string().trim().min(1).max(8192) });

export type SetModelCredentialRequest = z.infer<typeof SetModelCredentialRequest>;

export const ModelCredentialStatus = z.discriminatedUnion('source', [
  z.strictObject({ provider: ModelProvider, source: z.literal('client'), configured: z.literal(true) }),
  z.strictObject({ provider: ModelProvider, source: z.literal('worker'), configured: z.literal(true) }),
  z.strictObject({ provider: ModelProvider, source: z.literal('disabled'), configured: z.literal(false) }),
  z.strictObject({ provider: ModelProvider, source: z.literal('none'), configured: z.literal(false) }),
]);

export const StoredModelCredential = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('api_key'), key: SetModelCredentialRequest.shape.key }),
  z.strictObject({ kind: z.literal('disabled') }),
]);

// Resolved at sign-in from the allowed GitHub account; identity values are not secrets and may enter a sandbox.
export const GitIdentity = z.strictObject({
  login: z.string().min(1).max(100),
  name: z.string().min(1).max(256),
  email: z.string().min(3).max(320),
});

export type GitIdentity = z.infer<typeof GitIdentity>;

// What GET /v1/auth/token returns: the session token a client sends as `Authorization: Bearer <token>`.
export const AuthToken = z.strictObject({ token: z.string().min(1) });
