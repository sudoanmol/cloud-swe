import { expect, test } from "bun:test";
import { z } from "zod";
import { Freestyle } from "freestyle";
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
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const result = await handler(request);

      if (new URL(request.url).pathname.endsWith("/vms") && request.method === "GET" && result.ok) {
        const value = z.record(z.string(), z.unknown()).parse(await result.clone().json());

        if (!Object.hasOwn(value, "totalCount"))
          return Response.json({
            vms: [],
            totalCount: 1,
            runningCount: 0,
            startingCount: 0,
            pausingCount: 0,
          });
      }

      return result;
    },
  });

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

test("Freestyle unavailable errors retain their public classification without SDK details", async () => {
  await withProvider(
    () => Response.json({ message: "private-sdk-detail" }, { status: 500 }),
    async (provider) => {
      try {
        await provider.resolve(workspace, new AbortController().signal);
        throw new Error("Expected resolve to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);

        if (!(error instanceof Error)) throw error;
        expect(error).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
        expect(JSON.stringify(error)).not.toContain("private-sdk-detail");
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

test("paused and external VMs fill total provider capacity without creating or deleting resources", async () => {
  let creates = 0;
  let deletes = 0;
  await withProvider(
    (request) => {
      if (request.method === "POST") creates++;

      if (request.method === "DELETE") deletes++;

      if (new URL(request.url).pathname.endsWith("/vms"))
        return Response.json({
          vms: [],
          totalCount: 5,
          runningCount: 0,
          startingCount: 0,
          pausingCount: 0,
          pausedCount: 5,
          stoppedCount: 0,
        });

      return missing();
    },
    async (provider) => {
      await expect(
        provider.ensure({ ...workspace, providerId: null }, new AbortController().signal),
      ).rejects.toMatchObject({ code: "PROVIDER_CAPACITY" });
      expect(creates).toBe(0);
      expect(deletes).toBe(0);
    },
  );
});

test("a generic provider 429 is not misclassified as monthly allowance exhaustion", async () => {
  await withProvider(
    () => Response.json({ code: "RATE_LIMITED", message: "secret upstream text" }, { status: 429 }),
    async (provider) => {
      try {
        await provider.ensure(workspace, new AbortController().signal);
        throw new Error("Expected failure");
      } catch (error) {
        expect(error).not.toMatchObject({ code: "PROVIDER_MONTHLY_ALLOWANCE" });
        expect(error instanceof Error ? error.message : "").not.toContain("secret");
      }
    },
  );
});
