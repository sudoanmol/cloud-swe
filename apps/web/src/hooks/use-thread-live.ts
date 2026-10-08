import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";

import { staleQueries, applyThreadEvents } from "@/lib/thread-projection";
import { useEventBatcher, useThreadEvents } from "@/lib/use-thread-events";
import {
  questionsQueryOptions,
  threadProjectionQueryOptions,
  threadQueryOptions,
} from "@/lib/queries";

/**
 * The live event projection of one thread. The reader stays connected for an
 * idle thread too, so late title and workspace events still land.
 */
export function useThreadLive(userId: string, threadId: string) {
  const queryClient = useQueryClient();
  const { data: projection } = useQuery(threadProjectionQueryOptions(userId, threadId));
  const projectionRef = useRef(projection);

  const invalidateSnapshot = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["session", userId, "thread", threadId] });
    void queryClient.invalidateQueries({ queryKey: ["session", userId, "threads"] });
  }, [queryClient, threadId, userId]);

  const handleEvents = useEventBatcher((events, _cursor) => {
    const next = applyThreadEvents(projectionRef.current, events);
    projectionRef.current = next;
    queryClient.setQueryData(threadProjectionQueryOptions(userId, threadId).queryKey, next);

    // Run lifecycle and question boundaries change durable rows, so refetch the
    // snapshot and the question list instead of guessing their state. Replayed
    // events the cached snapshot already covers leave the snapshot alone.
    const stale = staleQueries(
      events,
      queryClient.getQueryData(threadQueryOptions(userId, threadId).queryKey)?.latestEventId ?? 0,
    );

    if (stale.snapshot) invalidateSnapshot();
    else if (stale.questions)
      void queryClient.invalidateQueries({
        queryKey: questionsQueryOptions(userId, threadId).queryKey,
      });
  });

  const readCursor = useCallback(() => projectionRef.current.cursor, []);

  const events = useThreadEvents({
    enabled: true,
    onConnected: invalidateSnapshot,
    onEvents: handleEvents,
    readCursor,
    threadId,
  });

  return { projection, events, invalidateSnapshot };
}
