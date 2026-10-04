import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { OptimisticMessage } from "./chat-types";

/** Accepted prompts live in the same account-scoped cache as server snapshots. */
export function optimisticQueryOptions(userId: string, threadId: string) {
  return queryOptions({
    queryKey: ["session", userId, "optimistic", threadId],
    queryFn: (): OptimisticMessage[] => [],
    initialData: (): OptimisticMessage[] => [],
    enabled: false,
    staleTime: Infinity,
  });
}

export function addOptimistic(
  client: QueryClient,
  userId: string,
  message: OptimisticMessage,
): void {
  client.setQueryData(optimisticQueryOptions(userId, message.threadId).queryKey, (current = []) => [
    ...current.filter((item) => item.clientMessageId !== message.clientMessageId),
    message,
  ]);
}

export function clearOptimistic(
  client: QueryClient,
  userId: string,
  threadId: string,
  clientMessageIds: readonly string[],
): void {
  client.setQueryData(optimisticQueryOptions(userId, threadId).queryKey, (current = []) =>
    current.filter((item) => !clientMessageIds.includes(item.clientMessageId)),
  );
}
