import { expect, test } from "bun:test";
import { Freestyle } from "freestyle";
import { z } from "zod";
import { createSnapshotResources } from "../src/snapshot-resources.js";

const requestSchema = z.object({
  slug: z.string(),
  maxRunSeconds: z.number(),
  maxRunTotalSeconds: z.number(),
  ttlSeconds: z.number(),
  automaticRestart: z.boolean(),
  metadata: z.record(z.string(), z.string()),
});

test("temporary VMs receive limits at creation, recover by identity, and retained resources pause", async () => {
  let vm: { id: string; state: string; metadata: Record<string, string> } | null = null;
  let creates = 0;
  let createInput: z.infer<typeof requestSchema> | undefined;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;

      if (request.method === "POST" && path.endsWith("/vms")) {
        creates++;
        createInput = requestSchema.parse(await request.json());
        vm = { id: "vm-builder", state: "running", metadata: createInput.metadata };

        return Response.json(
          { code: "TEMPORARY_FAILURE", message: "private detail" },
          { status: 503 },
        );
      }

      if (request.method === "POST" && path.endsWith("/pause")) {
        if (vm) vm.state = "paused";

        return Response.json(vm);
      }

      if (request.method === "DELETE") {
        vm = null;

        return new Response(null, { status: 204 });
      }

      return vm
        ? Response.json(vm)
        : Response.json({ code: "NOT_FOUND", message: "missing" }, { status: 404 });
    },
  });

  try {
    const resources = createSnapshotResources(
      new Freestyle({ apiKey: "test", baseUrl: server.url.toString() }),
    );

    const input = {
      slug: "builder",
      snapshotId: "base",
      purpose: "snapshot-builder" as const,
      buildId: "build-1",
      expiresAt: new Date(Date.now() + 86300000).toISOString(),
    };

    expect(await resources.create(input)).toBe("vm-builder");
    expect(await resources.create(input)).toBe("vm-builder");
    expect(creates).toBe(1);
    expect(createInput).toMatchObject({
      maxRunSeconds: 3600,
      maxRunTotalSeconds: 7200,
      automaticRestart: false,
    });
    expect(createInput?.ttlSeconds).toBeLessThanOrEqual(86400);
    await resources.cleanup({
      id: "vm-builder",
      purpose: "snapshot-builder",
      buildId: "build-1",
      keep: true,
    });
    expect(z.object({ state: z.string() }).parse(vm).state).toBe("paused");
    await expect(
      resources.cleanup({
        id: "vm-builder",
        purpose: "snapshot-builder",
        buildId: "wrong-build",
        keep: false,
      }),
    ).rejects.toThrow("ownership");
    await resources.cleanup({
      id: "vm-builder",
      purpose: "snapshot-builder",
      buildId: "build-1",
      keep: false,
    });
    expect(vm).toBeNull();
  } finally {
    await server.stop(true);
  }
});

test("failed temporary deletion attempts pause and reports cleanup failure without SDK text", async () => {
  let pauses = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      if (request.method === "DELETE")
        return Response.json({ code: "FAILED", message: "credential-secret" }, { status: 500 });

      if (request.method === "POST") pauses++;

      return Response.json({
        id: "vm-validation",
        state: pauses ? "paused" : "running",
        metadata: {
          "cloud-swe.project": "cloud-swe",
          "cloud-swe.purpose": "snapshot-validation",
          "cloud-swe.build": "build-2",
          "cloud-swe.expires": new Date(Date.now() + 100000).toISOString(),
        },
      });
    },
  });

  try {
    const resources = createSnapshotResources(
      new Freestyle({ apiKey: "test", baseUrl: server.url.toString() }),
    );

    await expect(
      resources.cleanup({
        id: "vm-validation",
        purpose: "snapshot-validation",
        buildId: "build-2",
        keep: false,
      }),
    ).rejects.toThrow("pause confirmed");
    expect(pauses).toBe(1);
  } finally {
    await server.stop(true);
  }
});
