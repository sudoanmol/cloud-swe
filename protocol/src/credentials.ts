/**
 * Path: protocol/src/credentials.ts
 * Used by: the @cloud-swe/protocol/credentials package export.
 * Purpose: Model credential, Git identity and sign-in schemas. Keys are write-only.
 */

import { z } from 'zod';

const ModelProvider = z.literal('anthropic');
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

// What GET /v1/auth/token and POST /v1/auth/exchange return: the session token a client sends as
// `Authorization: Bearer <token>`.
export const AuthToken = z.strictObject({ token: z.string().min(1) });

/*
 * App sign-in (RFC 8252, native apps, with PKCE from RFC 7636). The app opens GET /v1/auth/login with AppSignInQuery
 * in the system's sign-in sheet. After GitHub, the server redirects to `${APP_REDIRECT_URI}?code=<SignInCode>`, and
 * the app trades the code and its verifier at POST /v1/auth/exchange for the token. The token never appears in a URL.
 * GET /v1/auth/login without a query keeps the browser flow, which ends on GET /v1/auth/token for command-line use.
 */

// The app's private-use URI scheme (RFC 8252 section 7.1): its reverse-DNS bundle ID, lowercased. The only redirect.
export const APP_REDIRECT_URI = 'com.anmolhurkat.cloudswe:/sign-in';

// A code is good for one exchange within this many seconds.
export const SIGN_IN_CODE_TTL_SECONDS = 60;

// OAuth's own parameter names. A `redirect_uri` other than APP_REDIRECT_URI is refused with `invalid_redirect`.
export const AppSignInQuery = z.strictObject({
  redirect_uri: z.string().min(1).max(512),
  // base64url of the SHA-256 of the verifier, unpadded.
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code_challenge_method: z.literal('S256'),
});

export const LoginQuery = z.union([z.strictObject({}), AppSignInQuery]);

// 32 random bytes, base64url.
export const SignInCode = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const ExchangeSignInCodeRequest = z.strictObject({
  code: SignInCode,
  codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
});
