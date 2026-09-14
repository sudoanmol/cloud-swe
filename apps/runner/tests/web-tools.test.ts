import { describe, expect, test } from "bun:test";

import type { JsonValue } from "@cloud-swe/db/json";
import { createWebTools, validatePublicUrl, type WebToolsConfig } from "../src/web-tools";

type FetchLike = NonNullable<WebToolsConfig["fetch"]>;

function json(value: JsonValue, status = 200): Response {
  return Response.json(value, { status });
}

// SAFETY: The web tools under test do not read the Pi extension context.
const extensionContext = {} as never;

function tool(tools: ReturnType<typeof createWebTools>, name: "web_search" | "web_fetch") {
  const found = tools.find((candidate) => candidate.name === name);

  if (!found) throw new Error(`Missing ${name}`);

  return found;
}

function contentText(result: Awaited<ReturnType<ReturnType<typeof tool>["execute"]>>): string {
  const content = result.content[0];

  if (content?.type !== "text") throw new Error("Expected text tool output");

  return content.text;
}

describe("web tools", () => {
  test("registers tools only when their providers are configured", () => {
    expect(createWebTools({}).map(({ name }) => name)).toEqual([]);
    expect(createWebTools({ braveApiKey: "brave" }).map(({ name }) => name)).toEqual([
      "web_search",
    ]);
    expect(createWebTools({ firecrawlApiKey: "firecrawl" }).map(({ name }) => name)).toEqual([
      "web_search",
      "web_fetch",
    ]);
  });

  test("keeps Brave ranking, deduplicates normalized URLs, and preserves query parameters", async () => {
    const calls: Array<{ url: string; body?: string }> = [];

    const fetch: FetchLike = async (input, init) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? String(init.body) : undefined });

      if (url.startsWith("https://api.search.brave.com/res/v1/web/search"))
        return json({
          web: {
            results: [
              { title: "First", url: "https://example.com/a?x=1#section", description: "one" },
              { title: "Duplicate", url: "https://EXAMPLE.com/a?x=1", description: "same" },
              { title: "Second", url: "https://example.com/a?x=2", description: "two" },
              { title: "Unsafe", url: "http://127.0.0.1/private", description: "no" },
            ],
          },
        });

      return json({
        success: true,
        data: {
          markdown: `# Extracted ${calls.length}`,
          metadata: { title: "Page" },
        },
      });
    };

    const result = await tool(
      createWebTools({ braveApiKey: "brave", firecrawlApiKey: "fc", fetch }),
      "web_search",
    ).execute(
      "call",
      { query: "test", limit: 10, freshness: "week" },
      new AbortController().signal,
      undefined,
      extensionContext,
    );

    const value = JSON.parse(contentText(result));

    expect(value.results.map((item: { url: string }) => item.url)).toEqual([
      "https://example.com/a?x=1",
      "https://example.com/a?x=2",
    ]);
    expect(
      value.results.every((item: { extraction: string }) => item.extraction === "extracted"),
    ).toBe(true);
    expect(calls[0]!.url).toContain("freshness=pw");
    expect(calls[0]!.url).toContain("extra_snippets=true");
    expect(calls.filter(({ url }) => url === "https://api.firecrawl.dev/v2/scrape")).toHaveLength(
      2,
    );
  });

  test("falls back to Firecrawl search and translates freshness", async () => {
    const bodies: string[] = [];

    const fetch: FetchLike = async (input, init) => {
      const url = String(input);

      if (init?.body) bodies.push(String(init.body));

      if (url.includes("search.brave.com")) return json({ error: "limited" }, 429);

      if (url.endsWith("/search"))
        return json({
          success: true,
          data: [{ url: "https://example.com/result", title: "Fallback", description: "found" }],
        });

      return json({
        success: true,
        data: { markdown: "content", metadata: { sourceURL: "https://example.com/result" } },
      });
    };

    const result = await tool(
      createWebTools({ braveApiKey: "brave", firecrawlApiKey: "fc", fetch }),
      "web_search",
    ).execute(
      "call",
      { query: "fallback", freshness: "month" },
      new AbortController().signal,
      undefined,
      extensionContext,
    );

    const value = JSON.parse(contentText(result));

    expect(value.provider).toBe("firecrawl");
    expect(value.results).toHaveLength(1);
    expect(bodies).toContain(JSON.stringify({ query: "fallback", limit: 5, tbs: "qdr:m" }));
  });

  test("returns a bounded empty result from Firecrawl-only search", async () => {
    const endpoints: string[] = [];

    const result = await tool(
      createWebTools({
        firecrawlApiKey: "fc",
        fetch: async (input, init) => {
          endpoints.push(String(input));
          expect(init?.redirect).toBe("error");

          return json({ success: true, data: { web: [] } });
        },
      }),
      "web_search",
    ).execute(
      "call",
      { query: "nothing" },
      new AbortController().signal,
      undefined,
      extensionContext,
    );

    expect(JSON.parse(contentText(result))).toEqual({
      query: "nothing",
      provider: "firecrawl",
      status: "failed",
      partial: false,
      results: [],
    });
    expect(endpoints).toEqual(["https://api.firecrawl.dev/v2/search"]);
  });

  test("preserves valid results when extraction fails and bounds excerpts", async () => {
    const fetch: FetchLike = async (input) =>
      String(input).includes("search.brave.com")
        ? json({
            web: {
              results: [
                { title: "One", url: "https://example.com/one", description: "snippet" },
                { title: "Two", url: "https://example.com/two", description: "snippet" },
              ],
            },
          })
        : String(input).endsWith("/scrape")
          ? json({ success: false, error: "provider secret detail" }, 500)
          : json({});

    const result = await tool(
      createWebTools({ braveApiKey: "brave", firecrawlApiKey: "fc", fetch }),
      "web_search",
    ).execute(
      "call",
      { query: "partial" },
      new AbortController().signal,
      undefined,
      extensionContext,
    );

    const value = JSON.parse(contentText(result));

    expect(value.results.map((item: { extraction: string }) => item.extraction)).toEqual([
      "failed",
      "failed",
    ]);
    expect(JSON.stringify(value)).not.toContain("provider secret detail");
  });

  test("fetches through Firecrawl only, validates the final URL, and bounds content", async () => {
    const endpoints: string[] = [];

    const fetch: FetchLike = async (input, init) => {
      endpoints.push(String(input));
      expect(init?.redirect).toBe("error");
      expect(JSON.parse(String(init?.body))).toEqual({
        url: "https://example.com/report.pdf",
        formats: ["markdown"],
        onlyMainContent: true,
        maxAge: 0,
        parsers: [{ type: "pdf", maxPages: 10 }],
      });

      return json({
        success: true,
        data: {
          markdown: "x".repeat(70_000),
          metadata: {
            sourceURL: "https://example.com/final?download=1",
            title: "Report",
            contentType: "application/pdf",
          },
        },
      });
    };

    const result = await tool(
      createWebTools({ firecrawlApiKey: "fc", fetch }),
      "web_fetch",
    ).execute(
      "call",
      { url: "https://example.com/report.pdf", fresh: true },
      new AbortController().signal,
      undefined,
      extensionContext,
    );

    const value = JSON.parse(contentText(result));

    expect(endpoints).toEqual(["https://api.firecrawl.dev/v2/scrape"]);
    expect(value.finalUrl).toBe("https://example.com/final?download=1");
    expect(value.contentType).toBe("application/pdf");
    expect(Buffer.byteLength(value.content)).toBeLessThanOrEqual(65_536);
    expect(value.truncated).toBe(true);
  });

  test("rejects unsafe requested and reported URLs", async () => {
    const unsafe = [
      "file:///etc/passwd",
      "https://user:pass@example.com/",
      "http://localhost/",
      "http://service.local/",
      "http://127.0.0.1/",
      "http://2130706433/",
      "http://0x7f000001/",
      "http://[::1]/",
      "http://[fc00::1]/",
      "http://192.168.1.1/",
      "http://198.51.100.1/",
    ];

    for (const url of unsafe) expect(() => validatePublicUrl(url)).toThrow("public HTTP");

    const fetch: FetchLike = async () =>
      json({
        success: true,
        data: { markdown: "secret", metadata: { sourceURL: "http://127.0.0.1/admin" } },
      });

    const result = await tool(
      createWebTools({ firecrawlApiKey: "fc", fetch }),
      "web_fetch",
    ).execute(
      "call",
      { url: "https://example.com" },
      new AbortController().signal,
      undefined,
      extensionContext,
    );

    expect(JSON.parse(contentText(result))).toEqual({
      requestedUrl: "https://example.com/",
      finalUrl: null,
      title: null,
      contentType: null,
      content: "",
      truncated: false,
      status: "unsafe_final_url",
    });
  });

  test("rejects oversized and malformed provider responses without leaking their bodies", async () => {
    const oversizedFetch: FetchLike = async () =>
      new Response("secret-" + "x".repeat(2 * 1024 * 1024), {
        headers: { "content-type": "application/json" },
      });

    const oversized = await tool(
      createWebTools({ firecrawlApiKey: "fc", fetch: oversizedFetch }),
      "web_fetch",
    ).execute(
      "call",
      { url: "https://example.com" },
      new AbortController().signal,
      undefined,
      extensionContext,
    );

    expect(JSON.parse(contentText(oversized)).status).toBe("failed");
    expect(contentText(oversized)).not.toContain("secret-");

    const malformed = await tool(
      createWebTools({
        firecrawlApiKey: "fc",
        fetch: async () => json({ success: true, data: 1 }),
      }),
      "web_fetch",
    ).execute(
      "call",
      { url: "https://example.com" },
      new AbortController().signal,
      undefined,
      extensionContext,
    );

    expect(JSON.parse(contentText(malformed)).status).toBe("failed");
  });

  test("propagates cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(
      tool(
        createWebTools({ firecrawlApiKey: "fc", fetch: async () => json({}) }),
        "web_fetch",
      ).execute(
        "call",
        { url: "https://example.com" },
        controller.signal,
        undefined,
        extensionContext,
      ),
    ).rejects.toThrow("cancelled");
  });
});
