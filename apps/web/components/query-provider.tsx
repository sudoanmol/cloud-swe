"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThreadApiError } from "@cloud-swe/api/client";
import { useEffect, useRef, useState } from "react";

import { authClient } from "@/lib/auth-client";
import { clearAccountStorage } from "@/lib/account-storage";

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

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: shouldRetryRead, retryDelay, staleTime: 5_000 },
          mutations: { retry: false },
        },
      }),
  );

  const { data } = authClient.useSession();
  const userId = data?.user.id ?? null;
  const activeUserId = useRef(userId);

  useEffect(() => {
    if (activeUserId.current === userId) return;
    const previousUserId = activeUserId.current;
    activeUserId.current = userId;
    // Sign-out or account change: stop in-flight reads and drop every cached
    // response, draft and selection belonging to the previous account.
    void client.cancelQueries();
    client.clear();

    if (previousUserId)
      clearAccountStorage(previousUserId, window.sessionStorage, window.localStorage);
  }, [client, userId]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
