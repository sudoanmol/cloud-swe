/**
 * Path: server/test/event-stream.ts
 * Used by: server/test/{event-frames.test,tool-events.test}.ts.
 * Purpose: Reads snapshot frames from a session event stream.
 */

import assert from 'node:assert/strict';

import { SessionEvent, type Snapshot } from '@cloud-swe/protocol';

export async function sessionEvents(url: URL, headers: Record<string, string>) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(40_000) });
  assert.equal(response.status, 200);
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

  return { next, close: () => reader.cancel() };
}
