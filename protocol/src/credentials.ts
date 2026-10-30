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
