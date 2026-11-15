/**
 * Path: server/test/event-stream.ts
 * Used by: server/test/{event-frames.test,lifecycle-rig,tool-events.test,transcript.test,two-clients.test}.ts.
 * Purpose: Reads snapshot frames from a session event stream.
 */

import assert from 'node:assert/strict';

import { SessionEvent, type Snapshot } from '@cloud-swe/protocol';

export async function sessionEvents(url: URL, headers: Record<string, string>) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(40_000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type') ?? '', /text\/event-stream/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';

  const next = async (): Promise<Snapshot> => {
    for (;;) {
      const boundary = buffered.indexOf('\n\n');

      if (boundary >= 0) {
        const frame = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        const data = frame.split('\n').find((line) => line.startsWith('data: '));

        if (!data) continue;
        const event = SessionEvent.parse(JSON.parse(data.slice(6)));
        assert.equal(event.kind, 'snapshot');

        if (event.kind === 'snapshot') return event.snapshot;
      }

      const chunk = await reader.read();
      assert.equal(chunk.done, false, 'SSE closed before the expected snapshot');
      buffered += decoder.decode(chunk.value, { stream: true });
    }
  };

  /** Reads frames until one matches; the stream's own timeout bounds the wait. */
  const until = async (matches: (snapshot: Snapshot) => boolean) => {
    for (;;) {
      const snapshot = await next();

      if (matches(snapshot)) return snapshot;
    }
  };

  return { next, until, close: () => reader.cancel() };
}
