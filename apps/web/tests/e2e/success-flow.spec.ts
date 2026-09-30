import { expect, test } from "@playwright/test";
import { z } from "zod";

import { modelCatalogResponseSchema, threadSnapshotSchema } from "@cloud-swe/api/contracts";
import { modelSelectionSchema } from "@cloud-swe/db/model-contracts";

import { apiFetch, createUser, expectNoHorizontalOverflow, markOnboarded, signIn } from "./helpers";

const submissionAcceptedSchema = z.object({ runId: z.uuid(), threadId: z.uuid() });

/**
 * Success path against real routes: a fixture GitHub client supplies the
 * repository at the server boundary and the credential is stored through the
 * product's own endpoint, so the composer, admission, idempotency and cancel
 * paths are the real ones. Runs stay queued here because this suite starts no
 * dispatcher/worker; execution and replay are covered by the runner suites.
 */
const FIXTURE_REPO = "fixture-org/fixture-repo";

async function connectFixtureProvider(page: import("@playwright/test").Page): Promise<void> {
  const response = await apiFetch(page, "/api/model-providers/vercel-ai-gateway/credentials", {
    csrf: true,
    json: { apiKey: "fixture-provider-key" },
    method: "PUT",
  });

  // The product endpoint stores an encrypted credential and returns no body.
  expect(response.status, JSON.stringify(response.body)).toBe(204);
}

/** The first real catalog entry, so the selection is one the server accepts. */
async function firstCatalogModel(page: import("@playwright/test").Page) {
  const response = await apiFetch(page, "/api/model-providers/vercel-ai-gateway/models");

  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const body = modelCatalogResponseSchema.parse(response.body);
  const model = body.models[0];

  if (!model) throw new Error("the fixture provider catalog is empty");

  return modelSelectionSchema.parse({
    model: model.id,
    provider: "vercel-ai-gateway",
    thinkingLevel: model.thinkingLevels[0] ?? "off",
  });
}

async function prepareAccount(page: import("@playwright/test").Page) {
  const user = await createUser(page);

  await signIn(page, user);
  await connectFixtureProvider(page);
  await markOnboarded(user.id);

  return user;
}

async function sendPrompt(page: import("@playwright/test").Page, text: string): Promise<string> {
  const textbox = page.getByRole("textbox");

  await textbox.fill(text);
  await page.getByRole("button", { name: /^send$/i }).click();
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/u, { timeout: 30_000 });
  const url = new URL(page.url());

  return url.pathname.split("/").at(-1) ?? "";
}

test.describe("thread success path", () => {
  test("accepts a repository prompt with the selected model and shows it on the thread", async ({
    page,
  }) => {
    await prepareAccount(page);
    await page.goto("/");

    // The repository picker defaults to the only fixture repository.
    await expect(page.getByRole("button", { name: new RegExp(FIXTURE_REPO, "i") })).toBeVisible({
      timeout: 20_000,
    });

    // The repository and branch strip sits directly above the composer input,
    // not inside the footer controls.
    const repositoryButton = page.getByRole("button", { name: /fixture-org\/fixture-repo/i });
    const branchButton = page.getByRole("button", { name: /^main$/ });
    const textarea = page.getByRole("textbox").first();

    const repositoryBox = await repositoryButton.boundingBox();
    const branchBox = await branchButton.boundingBox();
    const textareaBox = await textarea.boundingBox();

    expect(repositoryBox, "the repository control must be rendered").not.toBeNull();
    expect(branchBox, "the branch control must be rendered").not.toBeNull();
    expect(textareaBox, "the composer input must be rendered").not.toBeNull();

    if (repositoryBox && branchBox && textareaBox) {
      expect(
        repositoryBox.y + repositoryBox.height,
        "the repository strip must sit above the composer input",
      ).toBeLessThanOrEqual(textareaBox.y);
      expect(
        branchBox.y,
        "the branch control must share the repository strip",
      ).toBeGreaterThanOrEqual(repositoryBox.y - 1);
      expect(branchBox.y).toBeLessThanOrEqual(repositoryBox.y + repositoryBox.height);
    }

    // Phone geometry on the pre-submission composer.
    await page.setViewportSize({ height: 844, width: 390 });
    await expectNoHorizontalOverflow(
      page,
      "new thread at 390x844",
      "/tmp/cloud-swe-geometry-new-thread-mobile.png",
    );

    const prompt = `run-${Date.now()}`;
    const threadId = await sendPrompt(page, prompt);

    await expect(page).toHaveURL(new RegExp(`/chat/${threadId}$`, "u"));
    await expect(page.getByText(prompt).first()).toBeVisible({ timeout: 20_000 });
    // Admitted run with no worker running: queued, and cancellable.
    await expect(page.getByText(/queued|working/i).first()).toBeVisible({ timeout: 20_000 });

    // The executing thread must also fit a phone without sideways scrolling.
    await expectNoHorizontalOverflow(
      page,
      "thread at 390x844",
      "/tmp/cloud-swe-geometry-thread-mobile.png",
    );

    await page.setViewportSize({ height: 800, width: 1280 });
    await expectNoHorizontalOverflow(
      page,
      "thread at 1280x800",
      "/tmp/cloud-swe-geometry-thread-desktop.png",
    );
  });

  test("lists fixture branches for the selected repository", async ({ page }) => {
    await prepareAccount(page);
    await page.goto("/");

    await page
      .getByRole("button", { name: /main|default/i })
      .first()
      .click();

    await expect(page.getByText("feature/one")).toBeVisible({ timeout: 20_000 });
  });

  test("a second run is refused while the thread already has an active run", async ({ page }) => {
    await prepareAccount(page);
    await page.goto("/");

    const first = `first-${Date.now()}`;
    const threadId = await sendPrompt(page, first);

    await expect(page.getByText(first).first()).toBeVisible({ timeout: 20_000 });

    // The first run is still queued, so this thread owns a mutating run.
    await page.getByRole("textbox").fill(`follow-${Date.now()}`);
    await page.keyboard.press("Enter");

    // Nothing new is admitted: the server keeps one mutating run per thread.
    await page.waitForTimeout(1_000);

    const snapshot = await apiFetch(page, `/api/threads/${threadId}`);

    expect(snapshot.status).toBe(200);
    expect(threadSnapshotSchema.parse(snapshot.body).runs).toHaveLength(1);
    expect(new URL(page.url()).pathname).toBe(`/chat/${threadId}`);
  });

  test("cancelling an active run records a cancellation request", async ({ page }) => {
    await prepareAccount(page);
    await page.goto("/");

    const threadId = await sendPrompt(page, `cancel-${Date.now()}`);

    await page.getByRole("button", { name: /stop/i }).first().click();

    // The cancellation is acknowledged before the snapshot catches up, and a
    // second Stop cannot be issued while it is pending.
    await expect(page.getByText(/cancelling/i).first()).toBeVisible({ timeout: 20_000 });
    // The control relabels itself while the cancellation is pending, so match
    // either label and require it to be inert.
    await expect(page.getByRole("button", { name: /stop|cancelling/i }).first()).toBeDisabled();

    await expect
      .poll(
        async () => {
          const snapshot = await apiFetch(page, `/api/threads/${threadId}`);

          if (snapshot.status !== 200) return "not-ok";

          const body = threadSnapshotSchema.parse(snapshot.body);

          return body.runs[0]?.cancelRequestedAt ? "cancelled" : "pending";
        },
        { timeout: 20_000 },
      )
      .toBe("cancelled");
  });

  test("an accepted envelope retried with the same client message id creates one run", async ({
    page,
  }) => {
    await prepareAccount(page);

    const clientMessageId = `retry-${Date.now()}`;

    const body = {
      clientMessageId,
      modelSelection: await firstCatalogModel(page),
      prompt: `dropped-${Date.now()}`,
      repositoryUrl: `https://github.com/${FIXTURE_REPO}`,
    };

    const first = await apiFetch(page, "/api/threads", { csrf: true, json: body, method: "POST" });

    expect(first.status, JSON.stringify(first.body)).toBe(202);
    const accepted = submissionAcceptedSchema.parse(first.body);

    // The browser never saw the first reply: the same envelope is retried.
    const second = await apiFetch(page, "/api/threads", { csrf: true, json: body, method: "POST" });

    expect(second.status, JSON.stringify(second.body)).toBe(202);
    expect(second.body).toMatchObject({
      runId: accepted.runId,
      threadId: accepted.threadId,
    });

    const snapshot = await apiFetch(page, `/api/threads/${accepted.threadId}`);

    expect(snapshot.status).toBe(200);
    expect(snapshot.body).toMatchObject({
      runs: [{ id: accepted.runId, status: "queued" }],
    });
  });
});
