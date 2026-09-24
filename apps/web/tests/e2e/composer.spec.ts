import { expect, test } from "@playwright/test";

import { threadSnapshotSchema } from "@cloud-swe/api/contracts";

import { apiFetch, createUser, markOnboarded, signIn } from "./helpers";

/**
 * Composer behaviour for an onboarded account.
 *
 * Repository metadata comes from the fixture GitHub client the test host injects,
 * so these assertions cover the thread a connected account actually gets: the
 * only repository is pre-selected, sending needs a prompt, and nothing is
 * admitted until the user submits.
 */
test.describe("new thread composer", () => {
  test.beforeEach(async ({ page }) => {
    const user = await createUser(page);

    await signIn(page, user);

    // A connected provider, as a real account has: without one there is no
    // model selection and sending stays blocked by design.
    const credential = await apiFetch(page, "/api/model-providers/vercel-ai-gateway/credentials", {
      csrf: true,
      json: { apiKey: "fixture-provider-key" },
      method: "PUT",
    });

    expect(credential.status, JSON.stringify(credential.body)).toBe(204);
    await markOnboarded(user.id);
    await page.goto("/");
    await expect(page.getByText(/what can i help with/i)).toBeVisible();
  });

  test("pre-selects the only repository and only enables sending with a prompt", async ({
    page,
  }) => {
    await expect(page.getByRole("button", { name: /fixture-org\/fixture-repo/i })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("button", { name: /^send$/i })).toBeDisabled();

    await page.getByRole("textbox").fill("Hello there");

    await expect(page.getByRole("button", { name: /^send$/i })).toBeEnabled();
    await expect(page.getByText(/select a repository to start a thread/i)).toBeHidden();
  });

  test("lists the repository from the backend when the picker opens", async ({ page }) => {
    await page.getByRole("button", { name: /fixture-org\/fixture-repo/i }).click();

    // The fixture account also serves generated siblings, so match exactly.
    await expect(
      page.getByRole("option", { name: "fixture-org/fixture-repo", exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/no repositories available/i)).toBeHidden();
  });

  test("uploads a multi-file selection two at a time and sends it in order", async ({ page }) => {
    const held: import("@playwright/test").Route[] = [];
    let release!: () => void;

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Hold uploads at the network boundary: this is the only way to observe the
    // real concurrency limit and that a third file waits for a free slot.
    await page.route("**/api/attachments*", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();

        return;
      }

      held.push(route);

      await gate;
      await route.continue();
    });

    const submitted: unknown[] = [];

    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/threads"))
        submitted.push(request.postDataJSON());
    });

    await page.setInputFiles("#new-thread-files", [
      { buffer: Buffer.from("alpha"), mimeType: "text/plain", name: "alpha.txt" },
      { buffer: Buffer.from("beta"), mimeType: "text/plain", name: "beta.txt" },
      { buffer: Buffer.from("gamma"), mimeType: "text/plain", name: "gamma.txt" },
    ]);

    // Exactly two uploads are in flight; the third has not been sent yet.
    await expect.poll(() => held.length, { timeout: 20_000 }).toBe(2);
    await page.waitForTimeout(750);
    expect(held, "a third upload must wait for a free slot").toHaveLength(2);

    release();

    await expect.poll(() => held.length, { timeout: 20_000 }).toBe(3);

    const surface = await page.locator("body").innerText();

    expect(surface, surface).not.toMatch(/at most|25 MB|50 MB|cannot use image|not configured/i);

    for (const name of ["alpha.txt", "beta.txt", "gamma.txt"])
      await expect(page.getByText(name, { exact: true })).toBeVisible({ timeout: 20_000 });

    await page.getByRole("textbox").fill(`files-${Date.now()}`);
    await page.getByRole("button", { name: /^send$/i }).click();
    await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/u, { timeout: 30_000 });

    const threadId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
    const snapshot = await apiFetch(page, `/api/threads/${threadId}`);

    expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(200);

    const prompt = threadSnapshotSchema
      .parse(snapshot.body)
      .messages.find((message) => message.role === "user");

    // The committed order is the selection order, whatever order uploads
    // finished in.
    expect(prompt?.attachments.map((attachment) => attachment.filename)).toEqual([
      "alpha.txt",
      "beta.txt",
      "gamma.txt",
    ]);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ attachmentIds: expect.any(Array) });
    // SAFETY: the assertion above proved `attachmentIds` is present and an array.
    expect((submitted[0] as { attachmentIds: unknown[] }).attachmentIds).toHaveLength(3);
  });

  test("keeps the draft when navigating away and back", async ({ page }) => {
    const draft = `draft-${Date.now()}`;

    await page.getByRole("textbox").fill(draft);
    await page.goto("/chat/22222222-2222-4222-8222-222222222222");
    await page.goto("/");

    await expect(page.getByRole("textbox")).toHaveValue(draft);
  });

  test("a missing thread renders an explained error, not a crash", async ({ page }) => {
    await page.goto("/chat/33333333-3333-4333-8333-333333333333");

    await expect(page.getByText(/no longer exists|thread not found/i).first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/application error|unhandled/i)).toBeHidden();
  });

  test("nothing is admitted before the user submits", async ({ page }) => {
    const threads = await apiFetch(page, "/api/threads?limit=20");

    expect(threads.status, JSON.stringify(threads.body)).toBe(200);
    expect(threads.body).toMatchObject({ threads: [], nextCursor: null });
  });
});
