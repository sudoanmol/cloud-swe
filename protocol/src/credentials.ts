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

export const SetGitHubCredentialRequest = z.strictObject({ token: z.string().trim().min(1).max(1024) });

export type SetGitHubCredentialRequest = z.infer<typeof SetGitHubCredentialRequest>;

// Resolved from the PAT's GitHub account; identity values are not secrets and may enter a sandbox.
export const GitIdentity = z.strictObject({
  login: z.string().min(1).max(100),
  name: z.string().min(1).max(256),
  email: z.string().min(3).max(320),
});

export type GitIdentity = z.infer<typeof GitIdentity>;

export const StoredGitHubCredential = z.strictObject({
  token: SetGitHubCredentialRequest.shape.token,
  identity: GitIdentity,
});

export const GitHubCredentialStatus = z.discriminatedUnion('configured', [
  z.strictObject({ configured: z.literal(true), login: GitIdentity.shape.login }),
  z.strictObject({ configured: z.literal(false) }),
]);
