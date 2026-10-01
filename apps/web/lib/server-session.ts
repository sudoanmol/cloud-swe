import { headers } from "next/headers";

import { authClient, type SessionUser } from "./auth-client";

export type ServerSession =
  | { status: "signed-in"; user: SessionUser }
  | { status: "signed-out" }
  /** The auth server could not be reached; the visitor is not treated as anonymous. */
  | { status: "unavailable" };

/**
 * Reads the session during the server render by forwarding the request cookies
 * to Better Auth. While the signed session-data cookie is fresh, Better Auth
 * answers from it without a database read, and the user carries the
 * server-owned `onboardingCompleted` flag, so no client round trip gates the page.
 */
export async function getServerSession(): Promise<ServerSession> {
  const cookie = (await headers()).get("cookie");

  if (!cookie) return { status: "signed-out" };

  try {
    const { data, error } = await authClient.getSession({
      fetchOptions: { cache: "no-store", headers: { cookie } },
    });

    if (error) return error.status === 401 ? { status: "signed-out" } : { status: "unavailable" };

    return data ? { status: "signed-in", user: data.user } : { status: "signed-out" };
  } catch {
    return { status: "unavailable" };
  }
}
