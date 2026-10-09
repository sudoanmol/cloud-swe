import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  createGitTextGenerator,
  createTitleGenerator,
  sanitizeTitle,
} from "../src/title-generation";

const capturedRequestBodySchema = z.object({
  model: z.string().optional(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })).optional(),
  max_tokens: z.number().optional(),
});

type CapturedRequest = {
  path: string;
  apiKey: string | null;
  body: z.infer<typeof capturedRequestBodySchema>;
  text: string;
};

type FixtureOptions = {
  statusFor?: (attempt: number) => number;
  delayMs?: number;
  content?: string | null;
  paddingBytes?: number;
};

const servers: Array<{ stop: () => void }> = [];

/** Answers the Anthropic Messages API; the generator reaches it through an injected fetch. */
function anthropicFixture(options: FixtureOptions = {}) {
  const requests: CapturedRequest[] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const attempt = requests.length + 1;
      const text = await request.text();

      requests.push({
        path: new URL(request.url).pathname,
        apiKey: request.headers.get("x-api-key"),
        body: capturedRequestBodySchema.parse(JSON.parse(text)),
        text,
      });

      if (options.delayMs) await Bun.sleep(options.delayMs);
      const status = options.statusFor?.(attempt) ?? 200;

      if (status !== 200)
        return new Response(
          JSON.stringify({
            error: { message: "upstream", pad: "x".repeat(options.paddingBytes ?? 0) },
          }),
          {
            status,
            headers: { "content-type": "application/json" },
          },
        );

      const content =
        options.content === undefined
          ? JSON.stringify({ title: "Add a login page", branch: "Add login page!" })
          : options.content;

      if (content === null) return new Response("not json", { status: 200 });

      return Response.json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [{ type: "text", text: content }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 4 },
        padding: "y".repeat(options.paddingBytes ?? 0),
      });
    },
  });

  servers.push({ stop: () => void server.stop(true) });
  const url = `http://127.0.0.1:${server.port}`;

  return {
    url,
    requests,
    fetch: (input: string | URL | Request, init?: RequestInit) =>
      fetch(`${url}${new URL(input instanceof Request ? input.url : input).pathname}`, init),
  };
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

/** Mirrors the durable at-most-once claim: one winner, prompts from the first message only. */
function fakeStore(input: { prompts: Record<string, string> }) {
  const claimed = new Set<string>();
  const claims: string[] = [];
  const titles: Array<{ threadId: string; title: string; branch: string | null }> = [];

  return {
    claimed,
    claims,
    titles,
    store: {
      async claimTitleGeneration({ threadId }: { threadId: string; userId: string }) {
        claims.push(threadId);

        if (claimed.has(threadId)) return { claimed: false, prompt: null };

        const prompt = input.prompts[threadId];

        if (prompt === undefined) return { claimed: false, prompt: null };

        claimed.add(threadId);

        return { claimed: true, prompt };
      },
      async completeTitleGeneration({
        threadId,
        title,
        branch,
      }: {
        threadId: string;
        userId: string;
        title: string;
        branch: string | null;
      }) {
        titles.push({ threadId, title, branch });
      },
    },
  };
}

function generatorFor(input: {
  fixture: ReturnType<typeof anthropicFixture>;
  fake: ReturnType<typeof fakeStore>;
  apiKey?: string;
  maxConcurrency?: number;
  timeoutMs?: number;
  responseMaxBytes?: number;
}) {
  const options: Parameters<typeof createTitleGenerator>[0] = {
    store: input.fake.store,
    fetch: input.fixture.fetch,
    logger: { warn: () => undefined },
  };

  if (input.apiKey !== undefined) options.apiKey = input.apiKey;

  if (input.maxConcurrency !== undefined) options.maxConcurrency = input.maxConcurrency;

  if (input.timeoutMs !== undefined) options.timeoutMs = input.timeoutMs;

  if (input.responseMaxBytes !== undefined) options.responseMaxBytes = input.responseMaxBytes;

  return createTitleGenerator(options);
}

async function settle(ms = 400): Promise<void> {
  await Bun.sleep(ms);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
}

describe("title sanitization", () => {
  test("bounds length and strips decoration", () => {
    expect(sanitizeTitle('  "Fix the login bug."  ')).toBe("Fix the login bug.");
    expect(sanitizeTitle("```ts\nconst x = 1\n```\nAdd a parser")).toBe("Add a parser");
    expect(sanitizeTitle("# Deploy pipeline")).toBe("Deploy pipeline");
    expect(sanitizeTitle("   ")).toBe(null);
    expect(sanitizeTitle("x".repeat(200))?.length).toBe(80);
  });
});

describe("at-most-once title generation", () => {
  test("calls Claude Haiku with the app key and saves the title and a work branch", async () => {
    const fixture = anthropicFixture();
    const fake = fakeStore({ prompts: { thread: "Add a login page to the app" } });
    const generator = generatorFor({ fixture, fake, apiKey: "app-owned-key" });

    generator.schedule({ threadId: "thread", userId: "user" });
    await waitFor(() => fake.titles.length === 1);

    expect(fake.titles[0]?.title).toBe("Add a login page");
    expect(fake.titles[0]?.branch).toMatch(/^cloudswe\/add-login-page-[0-9a-f]{4}$/);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]?.path).toBe("/v1/messages");
    expect(fixture.requests[0]?.apiKey).toBe("app-owned-key");
    expect(fixture.requests[0]?.body.model).toBe("claude-haiku-5-5");
    expect(fixture.requests[0]?.body.max_tokens).toBe(128);
    await generator.shutdown();
  });

  test("a replay, concurrency, and a restart produce exactly one request", async () => {
    const fixture = anthropicFixture({ delayMs: 20 });
    const fake = fakeStore({ prompts: { thread: "Explain the repository" } });
    const first = generatorFor({ fixture, fake, apiKey: "key", maxConcurrency: 4 });

    for (let index = 0; index < 8; index++) first.schedule({ threadId: "thread", userId: "user" });

    await waitFor(() => fake.titles.length === 1);
    await first.shutdown();

    // A new process attempts the same thread after the claim was consumed.
    const second = generatorFor({ fixture, fake, apiKey: "key" });

    second.schedule({ threadId: "thread", userId: "user" });
    await settle();
    await second.shutdown();

    expect(fixture.requests).toHaveLength(1);
    expect(fake.titles).toHaveLength(1);
  });

  test("does not retry a retryable 429 or 5xx response", async () => {
    for (const status of [429, 503]) {
      const fixture = anthropicFixture({ statusFor: () => status });
      const fake = fakeStore({ prompts: { thread: "task" } });
      const generator = generatorFor({ fixture, fake, apiKey: "key" });

      generator.schedule({ threadId: "thread", userId: "user" });
      await settle();
      await generator.shutdown();

      expect(fixture.requests.length).toBe(1);
      expect(fake.titles).toHaveLength(0);
    }
  });

  test("a missing application key consumes the claim and never generates later", async () => {
    const fixture = anthropicFixture();
    const fake = fakeStore({ prompts: { thread: "task" } });
    const generator = generatorFor({ fixture, fake });

    generator.schedule({ threadId: "thread", userId: "user" });
    await settle();
    await generator.shutdown();

    expect(fixture.requests).toHaveLength(0);
    expect(fake.claims).toEqual(["thread"]);
    expect(fake.claimed.has("thread")).toBe(true);

    // A later process has a key, but the accepted submission already consumed
    // the claim: the thread stays `New Thread` permanently.
    const later = generatorFor({ fixture, fake, apiKey: "key" });

    later.schedule({ threadId: "thread", userId: "user" });
    await settle();
    await later.shutdown();
    expect(fixture.requests).toHaveLength(0);
  });

  test("a blank first prompt makes no request", async () => {
    const fixture = anthropicFixture();
    const fake = fakeStore({ prompts: { thread: "   " } });
    const generator = generatorFor({ fixture, fake, apiKey: "key" });

    generator.schedule({ threadId: "thread", userId: "user" });
    await settle();
    await generator.shutdown();

    expect(fixture.requests).toHaveLength(0);
    expect(fake.titles).toHaveLength(0);
  });

  test("an invalid upstream body leaves the thread untitled", async () => {
    const fixture = anthropicFixture({ content: null });
    const fake = fakeStore({ prompts: { thread: "task" } });
    const generator = generatorFor({ fixture, fake, apiKey: "key" });

    generator.schedule({ threadId: "thread", userId: "user" });
    await settle();
    await generator.shutdown();

    expect(fake.titles).toHaveLength(0);
  });

  test("an oversized successful upstream body leaves the thread untitled", async () => {
    const fixture = anthropicFixture({ paddingBytes: 64 * 1024 });
    const fake = fakeStore({ prompts: { thread: "task" } });

    const generator = generatorFor({
      fixture,
      fake,
      apiKey: "key",
      responseMaxBytes: 8 * 1024,
    });

    generator.schedule({ threadId: "thread", userId: "user" });
    await settle();
    await generator.shutdown();

    expect(fixture.requests).toHaveLength(1);
    expect(fake.titles).toHaveLength(0);
  });

  test("an oversized error upstream body leaves the thread untitled", async () => {
    const fixture = anthropicFixture({ statusFor: () => 500, paddingBytes: 64 * 1024 });
    const fake = fakeStore({ prompts: { thread: "task" } });

    const generator = generatorFor({
      fixture,
      fake,
      apiKey: "key",
      responseMaxBytes: 8 * 1024,
    });

    generator.schedule({ threadId: "thread", userId: "user" });
    await settle();
    await generator.shutdown();

    expect(fixture.requests).toHaveLength(1);
    expect(fake.titles).toHaveLength(0);
  });

  test("the request deadline fires without shutdown", async () => {
    const fixture = anthropicFixture({ delayMs: 3_000 });
    const fake = fakeStore({ prompts: { thread: "task" } });
    const generator = generatorFor({ fixture, fake, apiKey: "key", timeoutMs: 50 });

    generator.schedule({ threadId: "thread", userId: "user" });
    const started = Date.now();

    await waitFor(() => fixture.requests.length === 1);
    // No shutdown call: the deadline alone must settle the attempt.
    await settle(500);

    expect(Date.now() - started).toBeLessThan(1_500);
    expect(fake.titles).toHaveLength(0);
    await generator.shutdown();
  });

  test("saturation consumes claims and bounds in-flight requests", async () => {
    const fixture = anthropicFixture({ delayMs: 60 });
    const prompts: Record<string, string> = {};

    for (let index = 0; index < 20; index++) prompts[`thread-${index}`] = "task";

    const fake = fakeStore({ prompts });
    const generator = generatorFor({ fixture, fake, apiKey: "key", maxConcurrency: 2 });

    for (let index = 0; index < 20; index++)
      generator.schedule({ threadId: `thread-${index}`, userId: "user" });

    await waitFor(() => fixture.requests.length >= 2);
    await settle(400);
    await generator.shutdown();

    // Every accepted submission consumed its claim; only the two admitted
    // requests ran, and the rest stay `New Thread` permanently.
    expect([...fake.claimed].sort()).toEqual(Object.keys(prompts).sort());
    expect(fixture.requests.length).toBe(2);
    expect(fake.titles.length).toBe(2);
  });
});

describe("manual Git text", () => {
  const local = {
    branch: "feature",
    head: "a".repeat(40),
    commit: "a".repeat(40),
    dirty: true,
    changedFiles: 1,
    fingerprint: "b".repeat(64),
    commits: "Fix the build\nAdd coverage",
    stat: "1 file changed",
    diff: "+fix",
  };

  const input = { threadTitle: "Thread title", base: "main", local };

  test("asks only for the blank fields and returns only those", async () => {
    const fixture = anthropicFixture({ content: JSON.stringify({ body: "Generated body" }) });
    const generate = createGitTextGenerator({ apiKey: "key", fetch: fixture.fetch });

    expect(await generate({ ...input, missing: ["body"] })).toEqual({ body: "Generated body" });
    expect(fixture.requests[0]?.text).toContain('\\"write\\":[\\"body\\"]');
    expect(await generate({ ...input, missing: [] })).toEqual({});
    expect(fixture.requests).toHaveLength(1);
  });

  test("falls back to commit subjects without a key or after a failure", async () => {
    const fallback = {
      commitMessage: "Fix the build",
      title: "Fix the build",
      body: local.commits,
    };

    const missing = ["commitMessage", "title", "body"] as const;

    expect(await createGitTextGenerator({})({ ...input, missing })).toEqual(fallback);
    expect(
      await createGitTextGenerator({
        apiKey: "key",
        fetch: async () => {
          throw new Error("unavailable");
        },
      })({ ...input, missing }),
    ).toEqual(fallback);
  });
});
