import { createServerFn } from "@tanstack/react-start";
import { getCookie, getRequestHeader } from "@tanstack/react-start/server";

import { authClient, type SessionUser } from "@/lib/auth-client";

export type ServerSession =
  | { status: "signed-in"; user: SessionUser }
  | { status: "signed-out" }
  /** The auth server could not be reached; the visitor is not treated as anonymous. */
  | { status: "unavailable" };

export type BootState = { session: ServerSession; sidebarOpen: boolean };

async function readSession(cookie: string | undefined): Promise<ServerSession> {
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

/**
 * Reads the session by forwarding the request cookies to Better Auth. While the
 * signed session-data cookie is fresh, Better Auth answers from it without a
 * database read, and the user carries the server-owned `onboardingCompleted`
 * flag, so no client round trip gates the page. During SSR this runs in-process;
 * after hydration it is only called again when the boot query is refreshed.
 */
export const getBootState = createServerFn({ method: "GET" }).handler(
  async (): Promise<BootState> => ({
    session: await readSession(getRequestHeader("cookie")),
    sidebarOpen: getCookie("sidebar_state") === "true",
  }),
);
