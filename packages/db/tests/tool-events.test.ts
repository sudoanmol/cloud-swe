import { describe, expect, test } from "bun:test";

import { decodeStructuredToolResult } from "../src/tool-events";

describe("structured tool result decoding", () => {
  test("current write results keep the guest's created/replaced fact", () => {
    expect(
      decodeStructuredToolResult(
        { kind: "write", path: "/workspace/a.ts", change: "created", bytes: 12 },
        "write",
      ),
    ).toEqual({ kind: "write", path: "/workspace/a.ts", change: "created", bytes: 12 });

    expect(
      decodeStructuredToolResult(
        { kind: "write", path: "/workspace/a.ts", change: "replaced", bytes: 12 },
        "write",
      ),
    ).toMatchObject({ change: "replaced" });
  });

  test("legacy web details normalize without a kind field", () => {
    expect(
      decodeStructuredToolResult(
        {
          query: "effect",
          provider: "brave",
          status: "ok",
          partial: false,
          results: [{ title: "Effect", url: "https://effect.website" }],
        },
        "web_search",
      ),
    ).toMatchObject({ kind: "search", query: "effect", status: "ok" });

    expect(
      decodeStructuredToolResult(
        {
          requestedUrl: "https://example.com",
          finalUrl: "https://example.com/",
          title: "Example",
          contentType: "text/html",
          content: "# Example",
          truncated: false,
          status: "ok",
        },
        "web_fetch",
      ),
    ).toMatchObject({ kind: "fetch", title: "Example", status: "ok" });
  });

  test("a truncated stringified wrapper falls back to plain text instead of throwing", () => {
    const truncated = '{"content":[{"type":"text","text":"hello"}],"details":{"kind":"wri';

    expect(decodeStructuredToolResult(truncated, "write")).toBe(null);
    expect(decodeStructuredToolResult("plain output", "bash")).toBe(null);
    expect(decodeStructuredToolResult({ unexpected: true }, "write")).toBe(null);
    expect(decodeStructuredToolResult(null, "write")).toBe(null);
  });

  test("stringified current results still decode", () => {
    expect(
      decodeStructuredToolResult(
        JSON.stringify({ kind: "write", path: "/workspace/a.ts", change: "replaced", bytes: 3 }),
      ),
    ).toMatchObject({ kind: "write", change: "replaced" });
  });
});
