"use client";

import type { ReplayPage, ThreadStreamEvent } from "@cloud-swe/api/client";
import { useEffect, useRef, useState } from "react";

import { api } from "./api";
import { consumeThreadEvents, type ThreadEventSource } from "./thread-event-reader";

export type { ThreadEventSource } from "./thread-event-reader";

export type ThreadEventStatus = ThreadEventSource["status"];

export function useThreadEvents(input: {
  threadId: string | null;
  enabled: boolean;
  readCursor: () => number;
  onEvents: (events: ThreadStreamEvent[], cursor: number) => void;
  onReplay: (page: ReplayPage) => void;
  onConnected?: () => void;
}): ThreadEventSource {
  const { threadId, enabled } = input;

  const [state, setState] = useState<ThreadEventSource>({
    status: "idle",
    error: null,
    retryInMs: null,
  });

  const handlers = useRef(input);
  handlers.current = input;

  useEffect(() => {
    if (!enabled || !threadId) {
      setState({ status: "idle", error: null, retryInMs: null });

      return;
    }

    const controller = new AbortController();

    const active = () =>
      !controller.signal.aborted &&
      handlers.current.threadId === threadId &&
      handlers.current.enabled;

    void consumeThreadEvents({
      threadId,
      signal: controller.signal,
      stream: api.streamEvents,
      readCursor: () => (active() ? handlers.current.readCursor() : 0),
      onEvents: (events, cursor) => {
        if (active()) handlers.current.onEvents(events, cursor);
      },
      onReplay: (page) => {
        if (active()) handlers.current.onReplay(page);
      },
      onConnected: () => {
        if (active()) handlers.current.onConnected?.();
      },
      onState: (value) => {
        if (active()) setState(value);
      },
    });

    return () => controller.abort();
  }, [enabled, threadId]);

  return state;
}
