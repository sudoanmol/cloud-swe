import { ThreadApiError } from "@cloud-swe/api/client";
import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";

import { routeTree } from "./routeTree.gen";

const MAX_READ_RETRIES = 3;

/**
 * Reads retry with bounded backoff. Auth, ownership and validation failures are
 * final, so a retry cannot turn them into a different answer.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- React Query hands retry policies an arbitrary thrown value; the check narrows it explicitly.
function shouldRetryRead(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_READ_RETRIES) return false;

  if (!(error instanceof ThreadApiError)) return true;

  if (error.status === 429) return true;

  return error.status >= 500 || error.status === 408;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- React Query hands retry delays an arbitrary thrown value; the check narrows it explicitly.
function retryDelay(attemptIndex: number, error: unknown): number {
  if (error instanceof ThreadApiError && error.retryAfterMs !== null) return error.retryAfterMs;

  return Math.min(1_000 * 2 ** attemptIndex, 30_000);
}

/** One router and query cache per request on the server, one per page in the browser. */
export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetryRead, retryDelay, staleTime: 5_000 },
      mutations: { retry: false },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    // React Query owns freshness; the router never caches loader results.
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  });

  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
