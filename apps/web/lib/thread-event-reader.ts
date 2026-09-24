import {
  ThreadApiError,
  type StreamEventsInput,
  type ThreadStreamEvent,
} from "@cloud-swe/api/client";
import { validateKnownThreadEvent } from "@cloud-swe/api/events";

export type ThreadEventSource = {
  status: "idle" | "connecting" | "live" | "reconnecting" | "stopped";
  error: ThreadApiError | null;
  retryInMs: number | null;
};

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };

    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });

    if (signal.aborted) finish();
  });
}

/** One disposable reader. Aborting it never requests run cancellation. */
export async function consumeThreadEvents(input: {
  threadId: string;
  signal: AbortSignal;
  stream: (input: StreamEventsInput) => Promise<void>;
  readCursor: () => number;
  onEvents: (events: ThreadStreamEvent[], cursor: number) => void;
  onConnected?: () => void;
  onState: (state: ThreadEventSource) => void;
  retryDelay?: (attempt: number) => number;
}): Promise<void> {
  let attempts = 0;
  const { signal } = input;
  input.onState({ status: "connecting", error: null, retryInMs: null });

  while (!signal.aborted) {
    let seen = input.readCursor();
    const initialCursor = seen;
    let pending: ThreadStreamEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let projectionError: ThreadApiError | undefined;
    const connection = new AbortController();
    const connectionSignal = AbortSignal.any([signal, connection.signal]);

    const flush = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;

      if (signal.aborted || !pending.length) return;
      const batch = pending;
      pending = [];

      try {
        input.onEvents(batch, seen);
      } catch {
        projectionError = new ThreadApiError(
          500,
          "PROTOCOL_ERROR",
          "Unable to project committed events",
        );
        connection.abort();
      }
    };

    let error: ThreadApiError | null = null;

    try {
      await input.stream({
        threadId: input.threadId,
        after: seen,
        signal: connectionSignal,
        onOpen: () => {
          if (signal.aborted) return;
          input.onState({ status: "live", error: null, retryInMs: null });
          input.onConnected?.();
        },
        onEvent: (event) => {
          if (connectionSignal.aborted || event.sequence <= seen) return;

          if (event.sequence !== seen + 1)
            throw new ThreadApiError(
              409,
              "EVENT_GAP",
              "Event gap; reconnecting from the last applied cursor",
            );

          try {
            validateKnownThreadEvent(event);
          } catch {
            throw new ThreadApiError(500, "PROTOCOL_ERROR", "Malformed committed event");
          }

          pending.push(event);
          seen = event.sequence;
          // A small batch works in background tabs too, where animation frames
          // may stop entirely. The count cap also bounds a fast replay burst.

          if (pending.length >= 100) flush();
          else if (timer === undefined) timer = setTimeout(flush, 16);
        },
      });
    } catch (failure) {
      if (failure instanceof ThreadApiError) error = failure;
    } finally {
      flush();
      connection.abort();
    }

    if (signal.aborted) return;
    error = projectionError ?? error;

    if (
      error &&
      ([401, 403, 404].includes(error.status) ||
        ["PROTOCOL_ERROR", "INVALID_RESPONSE"].includes(error.code))
    ) {
      input.onState({ status: "stopped", error, retryInMs: null });

      return;
    }

    if (input.readCursor() > initialCursor) attempts = 0;

    const retryInMs =
      error?.retryAfterMs ??
      (input.retryDelay
        ? input.retryDelay(attempts)
        : Math.round(
            Math.min(500 * 2 ** Math.min(attempts, 6), 15_000) * (0.5 + Math.random() * 0.5),
          ));

    attempts += 1;
    input.onState({ status: "reconnecting", error, retryInMs });
    await wait(retryInMs, signal);
  }
}
