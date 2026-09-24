import { expect, test, type Page } from "@playwright/test";

import { apiFetch, createUser, markOnboarded, signIn } from "./helpers";

/**
 * Repository and branch discovery against the fixture GitHub client, which
 * serves two installations and pages its repository and branch listings. Every
 * list, page and selection here goes through the real API.
 */
test.describe("github discovery", () => {
  test.beforeEach(async ({ page }) => {
    const user = await createUser(page);

    await signIn(page, user);

    const credential = await apiFetch(page, "/api/model-providers/vercel-ai-gateway/credentials", {
      csrf: true,
      json: { apiKey: "fixture-provider-key" },
      method: "PUT",
    });

    expect(credential.status, JSON.stringify(credential.body)).toBe(204);
    await markOnboarded(user.id);
    await page.goto("/");
    await expect(page.getByRole("button", { name: /fixture-org\/fixture-repo/i })).toBeVisible({
      timeout: 20_000,
    });
  });

  async function openRepositories(page: Page) {
    await page.getByRole("button", { name: /fixture-org\//i }).click();
  }

  test("switching installation lists that account's repositories and default branch", async ({
    page,
  }) => {
    await openRepositories(page);

    await page.getByLabel("GitHub installation").click();
    await page.getByRole("option", { name: "second-org" }).click();

    const secondRepo = page.getByRole("option", { name: /second-org\/only-repo/i });

    await expect(secondRepo).toBeVisible({ timeout: 20_000 });
    await secondRepo.click();

    // The default branch of the new repository is applied explicitly.
    await expect(page.getByRole("button", { name: /second-org\/only-repo/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^main$/ })).toBeVisible();
  });

  test("later repository pages load and stay selectable", async ({ page }) => {
    await openRepositories(page);

    await expect(page.getByRole("option", { name: /fixture-org\/fixture-repo$/i })).toBeVisible({
      timeout: 20_000,
    });

    // Page two only exists behind the load-more control.
    const secondPageRepo = page.getByRole("option", { name: /fixture-org\/fixture-repo-051/i });

    await expect(secondPageRepo).toBeHidden();

    const loadMore = page.getByRole("button", { name: "Load more repositories" });
    const popover = page.locator('[data-slot="popover-content"]');
    const loadMoreBox = await loadMore.boundingBox();
    const popoverBox = await popover.boundingBox();

    expect(
      { loadMoreBox, popoverBox },
      "the load-more control must be reachable inside the popover",
    ).toMatchObject({ loadMoreBox: expect.anything(), popoverBox: expect.anything() });

    if (loadMoreBox && popoverBox)
      expect(
        loadMoreBox.y + loadMoreBox.height,
        `load-more bottom ${Math.round(loadMoreBox.y + loadMoreBox.height)} vs popover bottom ${Math.round(popoverBox.y + popoverBox.height)}`,
      ).toBeLessThanOrEqual(popoverBox.y + popoverBox.height);

    await loadMore.click();
    await expect(secondPageRepo).toBeVisible({ timeout: 20_000 });

    await secondPageRepo.click();
    await expect(
      page.getByRole("button", { name: /fixture-org\/fixture-repo-051/i }),
    ).toBeVisible();
  });

  test("an empty repository is listed but cannot be selected", async ({ page }) => {
    await openRepositories(page);

    const empty = page.getByRole("option", { name: /empty-repo/i });

    await expect(empty).toBeVisible({ timeout: 20_000 });
    await expect(empty).toHaveAttribute("aria-disabled", "true");

    await empty.click({ force: true });

    // The previous selection stands: an empty repository never replaces it.
    await expect(page.getByRole("button", { name: /fixture-org\/fixture-repo$/i })).toBeVisible();
  });

  test("later branch pages load and the chosen branch is submitted", async ({ page }) => {
    await page.getByRole("button", { name: /^main$/ }).click();
    await expect(page.getByRole("option", { name: "feature/one" })).toBeVisible({
      timeout: 20_000,
    });

    const laterBranch = page.getByRole("option", { name: "release/1", exact: true });

    await expect(laterBranch).toBeHidden();

    await page.getByRole("button", { name: "Load more branches" }).click();
    await expect(laterBranch).toBeVisible({ timeout: 20_000 });
    await laterBranch.click();

    await expect(page.getByRole("button", { name: /^release\/1$/ })).toBeVisible();

    const submitted: unknown[] = [];

    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/threads"))
        submitted.push(request.postDataJSON());
    });

    await page.getByRole("textbox").fill(`branch-${Date.now()}`);
    await page.getByRole("button", { name: /^send$/i }).click();
    await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/u, { timeout: 30_000 });

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ branch: "release/1" });
  });
});
