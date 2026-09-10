import { describe, expect, test } from "bun:test";

import { consumeSse } from "../src/client";

describe("SSE frame parsing", () => {
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
});
