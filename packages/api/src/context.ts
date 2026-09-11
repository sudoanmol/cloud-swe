import type { IncomingHttpHeaders } from "node:http";

import { fromNodeHeaders } from "better-auth/node";

export type AuthSession = {
  user: {
    id: string;
    emailVerified?: boolean;
  };
  session: unknown;
};

export interface AuthProvider {
  getSession(headers: Headers): Promise<AuthSession | null>;
  handler(request: Request): Promise<Response>;
}

export async function createContext(auth: AuthProvider, req: IncomingHttpHeaders) {
  const session = await auth.getSession(fromNodeHeaders(req));

  return { session };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
