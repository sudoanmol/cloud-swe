import { expect, test, type Page } from "@playwright/test";

import {
  modelCatalogResponseSchema,
  submitResultSchema,
  threadSnapshotSchema,
} from "@cloud-swe/api/contracts";
import { modelSelectionSchema } from "@cloud-swe/db/model-contracts";

import { apiFetch, createUser, markOnboarded, signIn } from "./helpers";

/**
 * The fixture repository, cloned for real by the sandbox image: its Git config
 * rewrites this URL to a local bare origin, so the clone is genuine and offline.
 */
const CLONEABLE_REPO = "https://github.com/fixture-org/fixture-repo";

/**
 * The executed lifecycle with the real dispatcher and worker running
 * (`E2E_WITH_RUNNER=1`): a submission is admitted, executed in the sandbox
 * image, and its events are committed. No run is faked or completed by hand.
 *
 * Scope note: the initial submission is seeded through the REST API with a real
 * credential and the live catalog, so these specs cover admission, execution,
 * projection and replay. Composer-driven submission is covered by
 * `success-flow.spec.ts`, which runs without a worker.
 */
test.describe("executed run lifecycle", () => {
  test.skip(process.env.E2E_WITH_RUNNER !== "1", "requires the runner fixture");

  test.beforeEach(async ({ page }) => {
    const user = await createUser(page);

    await signIn(page, user);

    // A real credential through the product route; the model comes from the
    // live catalog so the selection is one the backend accepts.
    const credential = await apiFetch(page, "/api/model-providers/vercel-ai-gateway/credentials", {
      csrf: true,
      json: { apiKey: "fixture-provider-key" },
      method: "PUT",
    });

    expect(credential.status, JSON.stringify(credential.body)).toBe(204);
    await markOnboarded(user.id);
    await page.goto("/");
  });

  async function catalogSelection(page: Page) {
    const response = await apiFetch(page, "/api/model-providers/vercel-ai-gateway/models");

    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const entry = modelCatalogResponseSchema.parse(response.body).models[0];

    if (!entry) throw new Error("the gateway catalog returned no models");

    return modelSelectionSchema.parse({
      model: entry.id,
      provider: "vercel-ai-gateway",
      thinkingLevel: entry.thinkingLevels[0] ?? "off",
    });
  }

  async function submit(page: Page, prompt: string) {
    const response = await apiFetch(page, "/api/threads", {
      csrf: true,
      json: {
        attachmentIds: [],
        clientMessageId: `executed-${Date.now()}`,
        modelSelection: await catalogSelection(page),
        prompt,
        repositoryUrl: CLONEABLE_REPO,
      },
      method: "POST",
    });

    expect(response.status, JSON.stringify(response.body)).toBe(202);

    return submitResultSchema.parse(response.body);
  }

  async function snapshot(page: Page, threadId: string) {
    const response = await apiFetch(page, `/api/threads/${threadId}`);

    expect(response.status, JSON.stringify(response.body)).toBe(200);

    return threadSnapshotSchema.parse(response.body);
  }

  async function statuses(page: Page, threadId: string) {
    return (await snapshot(page, threadId)).runs.map((run) => run.status);
  }

  /** Polls a run to a terminal status and reports the backend's own failure. */
  async function expectStatus(page: Page, threadId: string, index: number, expected: string) {
    let observed = "unknown";

    await expect
      .poll(
        async () => {
          const run = (await snapshot(page, threadId)).runs[index];

          observed = run?.status ?? "missing";

          if (observed === "failed" || observed === "cancelled")
            throw new Error(
              `run ${index} ended as ${observed}: ${run?.error ?? "no error recorded"}`,
            );

          return observed;
        },
        { timeout: 180_000 },
      )
      .toBe(expected);

    expect(observed).toBe(expected);
  }

  async function assistantExcerpt(page: Page, threadId: string) {
    const committed = (await snapshot(page, threadId)).messages.find(
      (message) => message.role === "assistant" && message.content.trim().length > 0,
    );

    return (committed?.content ?? "").trim().slice(0, 40);
  }

  /** The reader must never report that it gave up on the stream. */
  async function expectStreamHealthy(page: Page) {
    await expect(page.getByText(/live updates stopped/i)).toHaveCount(0);
    await expect(page.getByText(/live output unavailable/i)).toHaveCount(0);
  }

  test("a submitted prompt completes and a reload replays the committed output", async ({
    page,
  }) => {
    const { threadId } = await submit(page, `executed-${Date.now()}`);

    await page.goto(`/chat/${threadId}`);
    await expectStatus(page, threadId, 0, "completed");

    const excerpt = await assistantExcerpt(page, threadId);

    expect(excerpt.length).toBeGreaterThan(0);
    await expect(page.getByText(excerpt, { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });

    // The guest really ran a command: a tool card is rendered from committed
    // events, so the transcript cannot be a snapshot of text alone.
    await expect(page.getByText(/^bash$/i).first()).toBeVisible({ timeout: 30_000 });
    await expectStreamHealthy(page);

    // A fresh document replays committed events instead of starting over.
    await page.reload();

    await expect(page.getByText(excerpt, { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/^bash$/i).first()).toBeVisible({ timeout: 30_000 });
    await expectStreamHealthy(page);
    expect(await statuses(page, threadId)).toEqual(["completed"]);
  });

  test("disconnecting while the run is active does not cancel it", async ({ page }) => {
    const { threadId } = await submit(page, `detached-${Date.now()}`);

    await page.goto(`/chat/${threadId}`);
    await expect
      .poll(async () => (await statuses(page, threadId)).at(0), { timeout: 60_000 })
      .toBe("running");

    // The reader goes away while the guest is still executing.
    await page.goto("/");

    await expectStatus(page, threadId, 0, "completed");

    const excerpt = await assistantExcerpt(page, threadId);

    await page.goto(`/chat/${threadId}`);
    await expect(page.getByText(excerpt, { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });
    // Reordered replayed events must still produce the tool card and final text.
    await expect(page.getByText(/^bash$/i).first()).toBeVisible({ timeout: 30_000 });
    await expectStreamHealthy(page);
    expect(await statuses(page, threadId)).toEqual(["completed"]);
  });

  test("a follow-up after completion is admitted as a second run", async ({ page }) => {
    const { threadId } = await submit(page, `first-${Date.now()}`);

    await expectStatus(page, threadId, 0, "completed");

    await page.goto(`/chat/${threadId}`);
    await page.getByRole("textbox").fill(`follow-${Date.now()}`);
    await page.keyboard.press("Enter");

    await expect
      .poll(async () => (await statuses(page, threadId)).length, {
        timeout: 60_000,
      })
      .toBe(2);
    await expectStatus(page, threadId, 1, "completed");
    expect(new URL(page.url()).pathname).toBe(`/chat/${threadId}`);
  });
});
