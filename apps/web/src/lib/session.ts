import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";

import type { SessionUser } from "@/lib/auth-client";
import { getBootState } from "@/server/session";

/**
 * Session and sidebar state for the document. The root route loads it once
 * during SSR and the query cache carries it to the client, so client
 * navigations reuse it instead of re-checking the session per click. Signing in
 * or out is a full page load; onboarding changes refresh it explicitly.
 */
export const bootQueryOptions = queryOptions({
  queryKey: ["boot"],
  queryFn: () => getBootState(),
  retry: false,
  staleTime: Number.POSITIVE_INFINITY,
});

/**
 * Re-reads the session after the server changed `onboardingCompleted`, so the
 * gates route on the new flag instead of the one cached at document load.
 */
export async function refreshBootState(queryClient: QueryClient): Promise<void> {
  await queryClient.fetchQuery({ ...bootQueryOptions, staleTime: 0 });
}

/**
 * The signed-in user resolved by the `_app` or `onboarding` gate. The user is
 * fixed for the lifetime of the rendered product tree.
 */
export function useSessionUser(): SessionUser {
  const { user } = useRouteContext({ strict: false });

  if (!user) throw new Error("useSessionUser must be used below a session gate");

  return user;
}
