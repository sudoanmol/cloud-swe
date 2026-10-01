import { afterAll, beforeAll, expect, test } from "bun:test";
import { ModalClient } from "modal";
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

const modalConfigured = Boolean(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET);

const deepseekApiKey = process.env.DEEPSEEK_API_KEY;

const harness = createIntegrationHarness({
  dbName: `cloud_swe_paid_${process.pid}`,
  portBase: 32_000,
  executionMode: "pi",
  sandboxProvider: "modal",
  idlePauseMs: 30_000,
  cleanupMs: 120_000,
  maxRunMs: 120_000,
});

const providerIds = new Set<string>();

if (enabled) {
  beforeAll(async () => {
    if (!modalConfigured || !deepseekApiKey)
      throw new Error(
        "RUN_PAID_INTEGRATION_TESTS=1 requires MODAL_TOKEN_ID, MODAL_TOKEN_SECRET, and DEEPSEEK_API_KEY",
      );
    await harness.setup();
  }, 120_000);

  afterAll(async () => {
    await harness.cleanup();

    if (!modalConfigured) return;
    const modal = new ModalClient({ environment: process.env.MODAL_ENVIRONMENT });

    for (const providerId of providerIds) {
      try {
        await (await modal.sandboxes.fromId(providerId)).terminate({ wait: true });
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
  "paid phase: Pi uses the Modal workspace and emits normalized events",
  async () => {
    const email = `paid-${process.pid}@example.com`;
    const signup = await harness.signup(email);
    // Onboarding needs a live GitHub App installation; the paid run only
    // exercises the model and sandbox path.
    await harness.query(`update "user" set onboarding_completed = true where email = $1`, [email]);

    const connected = await harness.http(
      "/api/model-providers/deepseek/credentials",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: deepseekApiKey }),
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
            provider: "deepseek",
            model: "deepseek-flash",
            thinkingLevel: "low",
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
    const providerId = (await harness.readWorkspaceRow(result.threadId))?.provider_id;
    expect(providerId).toBeTruthy();

    if (!providerId) throw new Error("paid run did not persist a Modal provider ID");
    expect(providerId).toMatch(/^sb-/);
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
