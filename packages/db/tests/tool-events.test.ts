import { describe, expect, test } from "bun:test";

import { decodeStructuredToolResult } from "../src/tool-events";

describe("structured tool result decoding", () => {
  test("current write results keep the guest's created/replaced fact", () => {
    expect(
      decodeStructuredToolResult(
        { kind: "write", path: "/workspace/a.ts", change: "created", bytes: 12 },
        "remote_write",
      ),
    ).toEqual({ kind: "write", path: "/workspace/a.ts", change: "created", bytes: 12 });

    expect(
      decodeStructuredToolResult(
        { kind: "write", path: "/workspace/a.ts", change: "replaced", bytes: 12 },
        "remote_write",
      ),
    ).toMatchObject({ change: "replaced" });
  });

  test("legacy edit results normalize to the edit kind", () => {
    const decoded = decodeStructuredToolResult(
      {
        version: 1,
        path: "/workspace/a.ts",
        replacementCount: 1,
        unifiedDiff: "--- a\n+++ b\n",
        additions: 1,
        deletions: 1,
        beforeHash: "a".repeat(64),
        afterHash: "b".repeat(64),
        diffTruncated: false,
      },
      "remote_edit",
    );

    expect(decoded).toMatchObject({ kind: "edit", replacementCount: 1, diffTruncated: false });
  });

  test("legacy edit results are only normalized for the edit tool", () => {
    const legacyEdit = {
      version: 1,
      path: "/workspace/a.ts",
      replacementCount: 1,
      unifiedDiff: "",
      additions: 1,
      deletions: 1,
      beforeHash: "a".repeat(64),
      afterHash: "b".repeat(64),
      diffTruncated: false,
    };

    // A legacy write reused the edit shape and cannot prove created/replaced.
    expect(decodeStructuredToolResult(legacyEdit, "remote_write")).toBe(null);
    expect(decodeStructuredToolResult(legacyEdit)).toBe(null);
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

    expect(decodeStructuredToolResult(truncated, "remote_write")).toBe(null);
    expect(decodeStructuredToolResult("plain output", "remote_exec")).toBe(null);
    expect(decodeStructuredToolResult({ unexpected: true }, "remote_write")).toBe(null);
    expect(decodeStructuredToolResult(null, "remote_write")).toBe(null);
  });

  test("stringified current results still decode", () => {
    expect(
      decodeStructuredToolResult(
        JSON.stringify({ kind: "write", path: "/workspace/a.ts", change: "replaced", bytes: 3 }),
      ),
    ).toMatchObject({ kind: "write", change: "replaced" });
  });
});
