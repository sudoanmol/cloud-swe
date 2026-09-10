import { expect, test } from "bun:test";
import { Freestyle, FreestyleApiError } from "freestyle";
import pino from "pino";
import { loadRunnerConfig } from "../src/config.js";
import { createFreestyleProvider } from "../src/freestyle.js";
import type { SandboxProvider, WorkspaceRef } from "../src/sandbox.js";

const workspace: WorkspaceRef = {
  id: "workspace-test",
  threadId: "thread-test",
  name: "cloud-swe-test",
  generation: 1,
  provider: "freestyle",
  providerId: "vm-test",
};
const metadata = {
  "cloud-swe.managed": "true",
  "cloud-swe.workspace": "cloud-swe-test",
  "cloud-swe.workspace-id": workspace.id,
  "cloud-swe.thread-id": workspace.threadId,
};
const data = (state: string) =>
  Response.json({ id: "vm-test", state, metadata, maxRunSeconds: 900 });
const missing = () => Response.json({ message: "missing" }, { status: 404 });

async function withProvider(
  handler: (request: Request) => Response | Promise<Response>,
  exercise: (provider: SandboxProvider) => Promise<void>,
  timeoutMs = 1_000,
) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  try {
    const client = new Freestyle({ apiKey: "test-only", baseUrl: server.url.toString() });
    const provider = createFreestyleProvider(
      {
        ...loadRunnerConfig(),
        sandboxProvider: "freestyle",
        freestyleApiKey: "test-only",
        freestyleAutoDeleteSeconds: 14_400,
        freestyleMaxRunSeconds: 900,
        providerTimeoutMs: timeoutMs,
      },
      pino({ enabled: false }),
      { client },
    );
    await exercise(provider);
  } finally {
    await server.stop(true);
  }
}

test("Freestyle starts once and polls with backoff while the state remains paused", async () => {
  let starts = 0;
  let polls = 0;
  const startTimes: number[] = [];
  await withProvider(
    (request) => {
      if (request.method === "POST") {
        starts += 1;
        return data("paused");
      }
      if (starts > 0) {
        polls += 1;
        startTimes.push(Date.now());
      }
      return data(polls >= 3 ? "running" : "paused");
    },
    async (provider) => {
      expect((await provider.ensure(workspace, new AbortController().signal)).providerId).toBe(
        "vm-test",
      );
      expect(starts).toBe(1);
      expect(startTimes[2]! - startTimes[0]!).toBeGreaterThanOrEqual(170);
    },
  );
});

test("Freestyle deletion polls until an asynchronous delete is confirmed missing", async () => {
  let deleting = false;
  let polls = 0;
  await withProvider(
    (request) => {
      if (request.method === "DELETE") {
        deleting = true;
        return new Response(null, { status: 204 });
      }
      if (deleting && ++polls >= 3) return missing();
      return data("running");
    },
    async (provider) => {
      expect((await provider.delete(workspace, new AbortController().signal)).outcome).toBe(
        "completed",
      );
      expect(polls).toBe(3);
    },
  );
});

test("Freestyle resolve shares one deadline across ID and slug lookups", async () => {
  let requests = 0;
  await withProvider(
    async () => {
      requests += 1;
      await Bun.sleep(70);
      return requests === 1 ? missing() : data("running");
    },
    async (provider) => {
      const started = Date.now();
      await expect(provider.resolve(workspace, new AbortController().signal)).rejects.toMatchObject(
        { kind: "timeout" },
      );
      expect(Date.now() - started).toBeLessThan(180);
    },
    100,
  );
});

test("Freestyle public errors retain SDK cause without exposing its message", async () => {
  await withProvider(
    () => Response.json({ message: "private-sdk-detail" }, { status: 500 }),
    async (provider) => {
      try {
        await provider.resolve(workspace, new AbortController().signal);
        throw new Error("Expected resolve to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        if (!(error instanceof Error)) throw error;
        expect(error.message).toBe("Freestyle VM resolve failed");
        expect(error.cause).toBeInstanceOf(FreestyleApiError);
      }
    },
  );
});

test("Freestyle aborted lifecycle never sends an HTTP request", async () => {
  let requests = 0;
  await withProvider(
    () => {
      requests += 1;
      return data("running");
    },
    async (provider) => {
      const signal = AbortSignal.abort();
      await expect(provider.resolve(workspace, signal)).rejects.toMatchObject({
        kind: "cancelled",
      });
      expect(requests).toBe(0);
    },
  );
});
