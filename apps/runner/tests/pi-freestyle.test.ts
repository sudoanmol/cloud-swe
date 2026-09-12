import { afterAll, beforeAll, expect, test } from "bun:test";
import { Freestyle } from "freestyle";
import { createIntegrationHarness, resultSchema } from "./integration-helpers.js";
import {
  createPiResourceLoader,
  normalizePiCommandResult,
  PI_TOOL_NAMES,
  workspacePath,
} from "../src/pi.js";
import { processResult, transportResult } from "../src/sandbox.js";

// Non-paid Pi boundary contract: only custom remote tools, spaces-safe
// remote_write quoting, and distinct provider outcomes. The paid phase stays
// gated behind RUN_PAID_INTEGRATION_TESTS=1 + credentials.

const enabled = process.env.RUN_PAID_INTEGRATION_TESTS === "1";

const freestyleApiKey = process.env.FREESTYLE_API_KEY;

const aiGatewayApiKey = process.env.AI_GATEWAY_API_KEY;

const harness = createIntegrationHarness({
  dbName: `cloud_swe_paid_${process.pid}`,
  portBase: 32_000,
  executionMode: "pi",
  sandboxProvider: "freestyle",
  idlePauseMs: 30_000,
  cleanupMs: 120_000,
  maxRunMs: 120_000,
  freestyleApiKey,
  freestyleAutoDeleteSeconds: process.env.FREESTYLE_AUTO_DELETE_SECONDS ?? "14400",
});

const providerIds = new Set<string>();

if (enabled) {
  beforeAll(async () => {
    if (!freestyleApiKey || !aiGatewayApiKey)
      throw new Error(
        "RUN_PAID_INTEGRATION_TESTS=1 requires FREESTYLE_API_KEY and AI_GATEWAY_API_KEY",
      );
    await harness.setup();
  }, 120_000);

  afterAll(async () => {
    await harness.cleanup();

    if (!freestyleApiKey) return;
    const freestyle = new Freestyle({ apiKey: freestyleApiKey });

    for (const providerId of providerIds) {
      try {
        await freestyle.vms.ref(providerId).delete();
      } catch {
        // The provider may have already expired or been deleted by test cleanup.
      }
    }
  }, 120_000);
}

test("pi boundary: Pi only receives custom remote tools (no worker-local tools)", () => {
  // The worker must never expose a local bash/read/edit tool: Pi operates on
  // the sandbox only through remote_exec/remote_read/remote_write, and the
  // resource loader must not discover worker-cwd skills, extensions, prompts,
  // themes, or agents files.
  expect([...PI_TOOL_NAMES]).toEqual(["remote_exec", "remote_read", "remote_write", "remote_edit"]);
  const loader = createPiResourceLoader();
  expect(loader.getExtensions().extensions).toEqual([]);
  expect(loader.getSkills().skills).toEqual([]);
  expect(loader.getPrompts().prompts).toEqual([]);
  expect(loader.getThemes().themes).toEqual([]);
  expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
  expect(loader.getSystemPrompt()).toBeUndefined();
  expect(loader.getSystemPromptSource()).toBeUndefined();
});

test("pi boundary: paths cannot traverse into the worker filesystem", () => {
  expect(workspacePath("src/file.ts")).toBe("/workspace/src/file.ts");
  expect(() => workspacePath("../../worker-secret")).toThrow("inside /workspace");
  expect(() => workspacePath("a\0b")).toThrow();
});

test("pi boundary: provider timeout/nonzero/output-limit/transport stay distinct", () => {
  // A nonzero guest exit is a tool result for Pi, never a transport failure.
  const nonzero = normalizePiCommandResult(processResult("out", "err", 7), 128);
  expect(nonzero.kind).toBe("nonzero");
  expect(nonzero.statusCode).toBe(7);
  expect(nonzero.diagnostic).toContain("exit code 7");
  const completed = normalizePiCommandResult(processResult("out", "", 0), 128);
  expect(completed.kind).toBe("completed");
  // Output limits are known-settled and remain retryable tool errors, not
  // ambiguous transport losses.
  const limited = normalizePiCommandResult(processResult("abcdefgh", "ijkl", 1), 5);
  expect(limited.kind).toBe("output-limit");
  expect(limited.outputTruncated).toBe(true);
  // Transport variants keep null status codes and distinct kinds so the
  // coordinator reconciles instead of releasing ownership.
  expect(normalizePiCommandResult(transportResult("transport-timeout", "deadline"), 128).kind).toBe(
    "transport-timeout",
  );
  expect(normalizePiCommandResult(transportResult("cancelled", "stopped"), 128).kind).toBe(
    "cancelled",
  );
  expect(normalizePiCommandResult(transportResult("unknown", "lost"), 128).kind).toBe("unknown");
  expect(
    normalizePiCommandResult(transportResult("transport-timeout", "deadline"), 128).statusCode,
  ).toBeNull();
});

test.skipIf(!enabled)(
  "paid phase: Pi uses the Freestyle workspace and emits normalized events",
  async () => {
    const email = `paid-${process.pid}@example.com`;
    const signup = await harness.signup(email);

    const connected = await harness.http(
      "/api/model-providers/vercel-ai-gateway/credentials",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: aiGatewayApiKey }),
      },
      signup,
    );

    expect(connected.response.status).toBe(204);

    const submitted = await harness.http(
      "/api/threads",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt:
            "Use remote_exec to run `printf completed`, then respond with the word completed.",
          clientMessageId: `paid-${process.pid}`,
          modelSelection: {
            provider: "vercel-ai-gateway",
            model: "meta/muse-spark-1.3-contributor",
            thinkingLevel: "medium",
          },
        }),
      },
      signup,
    );

    expect(submitted.response.status, submitted.text).toBe(202);
    const result = resultSchema.parse(submitted.body);

    const completed = await harness.waitSnapshot(
      signup,
      result.threadId,
      (snapshot) =>
        snapshot.runs.some(
          (run) =>
            run.id === result.runId && ["completed", "failed", "cancelled"].includes(run.status),
        ),
      { timeoutMs: 180_000, label: "paid Pi run" },
    );

    const run = completed.runs.find((item) => item.id === result.runId);
    expect(run).toBeDefined();
    expect(run?.status, run?.error ?? "paid Pi run failed").toBe("completed");
    const providerId = completed.workspace?.providerId;
    expect(providerId).toBeTruthy();

    if (!providerId) throw new Error("paid run did not persist a Freestyle provider ID");
    expect(providerId).not.toMatch(/^cloud-swe-/);
    providerIds.add(providerId);

    const events = await harness.readSse(signup, result.threadId, 0, new Set(["run.completed"]), {
      timeoutMs: 30_000,
    });

    const types = new Set(events.map((event) => event.type));

    for (const type of [
      "assistant.started",
      "assistant.delta",
      "tool.started",
      "tool.output",
      "tool.completed",
      "run.completed",
    ]) {
      expect(types.has(type), `missing normalized Pi event ${type}`).toBe(true);
    }

    expect(
      events
        .filter((event) => event.type === "assistant.delta" || event.type.startsWith("tool."))
        .every((event) => event.payload.runId === result.runId),
    ).toBe(true);
  },
  240_000,
);
