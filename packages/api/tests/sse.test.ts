import { describe, expect, spyOn, test } from "bun:test";

import {
  SSE_MAX_BUFFER_BYTES,
  consumeSse,
  createApiTransport,
  type ThreadStreamEvent,
} from "../src/client";

/** Events with multi-byte text, so chunk splits land inside characters and CRLF pairs. */
function largeHistory(count: number, textBytes: number): ThreadStreamEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    sequence: index + 1,
    type: "tool.output",
    payload: { text: `${index}é✓`.padEnd(textBytes, "x") },
  }));
}

function sseBody(events: ThreadStreamEvent[]): Uint8Array {
  return new TextEncoder().encode(
    events
      .map(
        (item) =>
          `id: ${item.sequence}\r\nevent: ${item.type}\r\ndata: ${JSON.stringify(item.payload)}\r\n\r\n`,
      )
      .join(""),
  );
}

function split(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];

  for (let offset = 0; offset < bytes.length; offset += size)
    chunks.push(bytes.subarray(offset, offset + size));

  return chunks;
}

/** Streams the given reads exactly as split, as a browser hands over buffered bytes. */
async function readAll(chunks: Uint8Array[]) {
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(chunk);
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  const events: ThreadStreamEvent[] = [];
  let failure: unknown;

  try {
    await createApiTransport({ baseUrl: "http://test" }).streamEvents({
      threadId: "t",
      onEvent: (item) => events.push(item),
    });
  } catch (error) {
    failure = error;
  } finally {
    fetch.mockRestore();
  }

  return { events, failure };
}

describe("SSE frame parsing", () => {
  test("replays persisted compaction and steer events in sequence across split frames", async () => {
    const history: ThreadStreamEvent[] = [
      {
        sequence: 10,
        type: "message.pending",
        payload: { messageId: "message", runId: "run", mode: "steer" },
      },
      {
        sequence: 11,
        type: "context.compacted",
        payload: {
          runId: "run",
          attemptId: "attempt",
          entryId: "summary",
          reason: "threshold",
          tokensBefore: 10000,
          contextTokens: 500,
        },
      },
      {
        sequence: 12,
        type: "message.steered",
        payload: {
          messageId: "message",
          runId: "run",
          attemptId: "attempt",
          entryId: "entry",
          content: "Change direction é",
          clientMessageId: "client",
          attachments: [],
        },
      },
    ];

    const read = await readAll(split(sseBody(history), 7));
    expect(read.failure).toBeUndefined();
    expect(read.events).toEqual(history);
  });

  test("parses a frame split between CR and LF", () => {
    const first = consumeSse("id: 3\r");
    expect(first.events).toEqual([]);
    expect(first.rest.endsWith("\r")).toBe(true);

    const second = consumeSse(`${first.rest}\nevent: run.queued\r\ndata: {"ok":true}\r\n\r\n`);
    expect(second.events).toEqual([{ sequence: 3, type: "run.queued", payload: { ok: true } }]);
    expect(second.rest).toBe("");
  });

  test("keeps event lines when a comment shares the frame", () => {
    const parsed = consumeSse(": heartbeat\nid: 4\nevent: run.cancelled\ndata: {}\n\n");
    expect(parsed.events).toEqual([{ sequence: 4, type: "run.cancelled", payload: {} }]);
  });

  test("ignores a comment-only heartbeat frame", () => {
    const parsed = consumeSse(": heartbeat\n\nid: 5\nevent: run.queued\ndata: {}\n\n");
    expect(parsed.events).toEqual([{ sequence: 5, type: "run.queued", payload: {} }]);
  });

  test("drops a frame cut off by end of stream instead of parsing it", async () => {
    const body = 'id: 1\nevent: run.queued\ndata: {}\n\nid: 2\nevent: run.started\ndata: {"ru';

    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
        { preconnect: globalThis.fetch.preconnect },
      ),
    );

    const events: ThreadStreamEvent[] = [];

    try {
      await createApiTransport({ baseUrl: "http://test" }).streamEvents({
        threadId: "t",
        onEvent: (event) => events.push(event),
      });
    } finally {
      fetch.mockRestore();
    }

    expect(events).toEqual([{ sequence: 1, type: "run.queued", payload: {} }]);
  });

  test("a read holding more than the frame limit of complete frames yields the same events as small reads", async () => {
    const history = largeHistory(400, 4_000);
    const body = sseBody(history);
    expect(body.length).toBeGreaterThan(SSE_MAX_BUFFER_BYTES);

    for (const size of [body.length, 65_536, 4_093]) {
      const read = await readAll(split(body, size));
      expect(read.failure).toBeUndefined();
      expect(read.events).toEqual(history);
    }
  });

  test("one unfinished frame over the limit still stops after the complete frames before it", async () => {
    const before = largeHistory(2, 100);

    const body = new Uint8Array([
      ...sseBody(before),
      ...new TextEncoder().encode(
        `id: 3\nevent: tool.output\ndata: "${"x".repeat(SSE_MAX_BUFFER_BYTES)}`,
      ),
    ]);

    for (const size of [body.length, 65_536]) {
      const read = await readAll(split(body, size));
      expect(read.events).toEqual(before);
      expect(read.failure).toMatchObject({ code: "PROTOCOL_ERROR" });
    }
  });
});
