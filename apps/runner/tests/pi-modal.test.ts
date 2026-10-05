import { afterAll, beforeAll, expect, test } from "bun:test";
import { ModalClient } from "modal";
import { createIntegrationHarness, resultSchema } from "./integration-helpers.js";

// Paid Pi run against a live Modal workspace, gated behind
// RUN_PAID_INTEGRATION_TESTS=1 + credentials.

const enabled = process.env.RUN_PAID_INTEGRATION_TESTS === "1";

const modalConfigured = Boolean(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET);

const deepseekApiKey = process.env.DEEPSEEK_API_KEY;

const harness = createIntegrationHarness({
  dbName: `cloud_swe_paid_${process.pid}`,
  portBase: 32_000,
  executionMode: "pi",
  sandboxProvider: "modal",
  idlePauseMs: 30_000,
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
          prompt: "Use bash to run `printf completed`, then respond with the word completed.",
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
