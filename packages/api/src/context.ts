import type { IncomingHttpHeaders } from "node:http";

import { auth } from "@cloud-swe/auth";
import { fromNodeHeaders } from "better-auth/node";

export async function createContext(req: IncomingHttpHeaders) {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req),
  });
  return {
    auth: null,
    session,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
