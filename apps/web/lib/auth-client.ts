import { inferAdditionalFields } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import type { createAuth } from "@cloud-swe/auth";

import { apiBaseUrl } from "./api";

/**
 * Better Auth talks to Fastify directly. The extra client field is inferred
 * from the server options, so the onboarding flag is never re-declared here.
 */
type ServerAuth = ReturnType<typeof createAuth>;

export const authClient = createAuthClient({
  baseURL: apiBaseUrl,
  fetchOptions: { credentials: "include" },
  plugins: [inferAdditionalFields<ServerAuth>()],
});

export type SessionUser = typeof authClient.$Infer.Session.user;
