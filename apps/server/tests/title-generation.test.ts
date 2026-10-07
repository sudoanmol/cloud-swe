import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";

import { createTitleGenerator, sanitizeTitle } from "../src/title-generation";

type CapturedRequest = {
  path: string;
  authorization: string | null;
  body: {
    model?: string;
    messages?: Array<{ role: string; content: string }>;
    max_tokens?: number;
    thinking?: { type?: string };
  };
};

const capturedRequestBodySchema = z.object({
  model: z.string().optional(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })).optional(),
  max_tokens: z.number().optional(),
  thinking: z.object({ type: z.string().optional() }).optional(),
});

type FixtureOptions = {
  statusFor?: (attempt: number) => number;
  delayMs?: number;
  content?: string | null;
  paddingBytes?: number;
};

const servers: Array<{ stop: () => void }> = [];

function deepSeekFixture(options: FixtureOptions = {}) {
  const requests: CapturedRequest[] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const attempt = requests.length + 1;
      const body = capturedRequestBodySchema.parse(await request.json());

      requests.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        body,
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

      const content = options.content === undefined ? "Add a login page" : options.content;

      if (content === null) return new Response("not json", { status: 200 });

      return Response.json({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1,
        model: "deepseek-flash",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        padding: "y".repeat(options.paddingBytes ?? 0),
      });
    },
  });

  servers.push({ stop: () => void server.stop(true) });

  return { url: `http://127.0.0.1:${server.port}`, requests };
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

/** Mirrors the durable at-most-once claim: one winner, prompts from the first message only. */
function fakeStore(input: { prompts: Record<string, string> }) {
  const claimed = new Set<string>();
  const claims: string[] = [];
  const titles: Array<{ threadId: string; title: string }> = [];

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
      }: {
        threadId: string;
        userId: string;
        title: string;
      }) {
        titles.push({ threadId, title });
      },
    },
  };
}

function generatorFor(input: {
  fixture: { url: string };
  fake: ReturnType<typeof fakeStore>;
  apiKey?: string;
  maxConcurrency?: number;
  timeoutMs?: number;
  responseMaxBytes?: number;
}) {
  const options: Parameters<typeof createTitleGenerator>[0] = {
    store: input.fake.store,
    apiUrl: input.fixture.url,
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
  test("calls the configured DeepSeek base URL with the fixed model, app key, and thinking disabled", async () => {
    const fixture = deepSeekFixture();
    const fake = fakeStore({ prompts: { thread: "Add a login page to the app" } });
    const generator = generatorFor({ fixture, fake, apiKey: "app-owned-key" });

    generator.schedule({ threadId: "thread", userId: "user" });
    await waitFor(() => fake.titles.length === 1);

    expect(fake.titles).toEqual([{ threadId: "thread", title: "Add a login page" }]);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]?.path).toBe("/chat/completions");
    expect(fixture.requests[0]?.authorization).toBe("Bearer app-owned-key");
    expect(fixture.requests[0]?.body.model).toBe("deepseek-flash");
    expect(fixture.requests[0]?.body.max_tokens).toBe(128);
    expect(fixture.requests[0]?.body.thinking).toEqual({ type: "disabled" });
    await generator.shutdown();
  });

  test("a replay, concurrency, and a restart produce exactly one request", async () => {
    const fixture = deepSeekFixture({ delayMs: 20 });
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
      const fixture = deepSeekFixture({ statusFor: () => status });
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
    const fixture = deepSeekFixture();
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
    const fixture = deepSeekFixture();
    const fake = fakeStore({ prompts: { thread: "   " } });
    const generator = generatorFor({ fixture, fake, apiKey: "key" });

    generator.schedule({ threadId: "thread", userId: "user" });
    await settle();
    await generator.shutdown();

    expect(fixture.requests).toHaveLength(0);
    expect(fake.titles).toHaveLength(0);
  });

  test("an invalid upstream body leaves the thread untitled", async () => {
    const fixture = deepSeekFixture({ content: null });
    const fake = fakeStore({ prompts: { thread: "task" } });
    const generator = generatorFor({ fixture, fake, apiKey: "key" });

    generator.schedule({ threadId: "thread", userId: "user" });
    await settle();
    await generator.shutdown();

    expect(fake.titles).toHaveLength(0);
  });

  test("an oversized successful upstream body leaves the thread untitled", async () => {
    const fixture = deepSeekFixture({ paddingBytes: 64 * 1024 });
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
    const fixture = deepSeekFixture({ statusFor: () => 500, paddingBytes: 64 * 1024 });
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
    const fixture = deepSeekFixture({ delayMs: 3_000 });
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
    const fixture = deepSeekFixture({ delayMs: 60 });
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

test("manual Git defaults fall back to commits without a key or after generation failure", async () => {
  const { createGitTextGenerator } = await import("../src/title-generation");

  const input = {
    title: "Thread title",
    head: "a".repeat(40),
    branch: "feature",
    base: "main",
    dirty: true,
    fingerprint: "b".repeat(64),
    commits: "Fix the build\nAdd coverage",
    stat: "1 file changed",
    diff: "+fix",
    generation: 1,
  };

  const fallback = { commitMessage: "Fix the build", title: "Fix the build", body: input.commits };
  expect(await createGitTextGenerator({ apiUrl: "https://example.test" })(input)).toEqual(fallback);
  expect(
    await createGitTextGenerator({
      apiUrl: "https://example.test",
      apiKey: "test",
      fetch: async () => {
        throw new Error("unavailable");
      },
    })(input),
  ).toEqual(fallback);
});
