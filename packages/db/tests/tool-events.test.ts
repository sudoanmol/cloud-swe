import { describe, expect, test } from "bun:test";

import { decodeStructuredToolResult } from "../src/tool-events";

describe("structured tool result decoding", () => {
  test("current write results keep the guest's created/replaced fact", () => {
    expect(
      decodeStructuredToolResult({
        kind: "write",
        path: "/workspace/a.ts",
        change: "created",
        bytes: 12,
      }),
    ).toEqual({ kind: "write", path: "/workspace/a.ts", change: "created", bytes: 12 });

    expect(
      decodeStructuredToolResult({
        kind: "write",
        path: "/workspace/a.ts",
        change: "replaced",
        bytes: 12,
      }),
    ).toMatchObject({ change: "replaced" });
  });

  test("a truncated stringified wrapper falls back to plain text instead of throwing", () => {
    const truncated = '{"content":[{"type":"text","text":"hello"}],"details":{"kind":"wri';

    expect(decodeStructuredToolResult(truncated)).toBe(null);
    expect(decodeStructuredToolResult("plain output")).toBe(null);
    expect(decodeStructuredToolResult({ unexpected: true })).toBe(null);
    expect(decodeStructuredToolResult(null)).toBe(null);
  });

  test("stringified current results still decode", () => {
    expect(
      decodeStructuredToolResult(
        JSON.stringify({ kind: "write", path: "/workspace/a.ts", change: "replaced", bytes: 3 }),
      ),
    ).toMatchObject({ kind: "write", change: "replaced" });
  });
});
