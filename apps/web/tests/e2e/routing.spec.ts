import { expect, test } from "@playwright/test";

import { apiFetch, countThreads, createUser, markOnboarded, signIn } from "./helpers";

/**
 * Routing matrix against a real session and a real backend.
 *
 * The gate must decide from our authenticated onboarding response, and no
 * protected query or SSE reader may start before completion.
 */
function trackProtectedRequests(page: import("@playwright/test").Page): string[] {
  const protectedUrls: string[] = [];

  page.on("request", (request) => {
    const url = request.url();

    if (url.includes("/api/threads") || url.includes("/api/attachments")) protectedUrls.push(url);
  });

  return protectedUrls;
}

test.describe("routing and onboarding gate", () => {
  test.beforeEach(async ({ context }) => {
    // The product sidebar starts expanded in this suite so its controls are
    // reachable; the collapsed rail is a separate layout concern.
    await context.addCookies([
      { name: "sidebar_state", value: "true", url: "http://127.0.0.1:3310" },
    ]);
  });

  test("anonymous `/` is the landing and starts no protected query", async ({ page }) => {
    const protectedUrls = trackProtectedRequests(page);

    await page.goto("/");

    await expect(page.getByRole("button", { name: /sign in with github/i })).toBeVisible();
    await expect(page.getByText("cloud-swe").first()).toBeVisible();
    expect(protectedUrls).toEqual([]);
  });

  test("anonymous chat route returns to the landing", async ({ page }) => {
    await page.goto("/chat/11111111-1111-4111-8111-111111111111");

    await expect(page.getByRole("button", { name: /sign in with github/i })).toBeVisible();
    await expect(page).not.toHaveURL(/\/chat\//u);
  });

  test("signed-in but incomplete session reaches `/onboarding` and no thread request fires", async ({
    page,
  }) => {
    const user = await createUser(page);
    const protectedUrls = trackProtectedRequests(page);

    await signIn(page, user);
    await page.goto("/");

    await expect(page).toHaveURL(/\/onboarding$/u);
    // GitHub is not configured in the suite, so readiness is transient, not
    // a claim that the installation disappeared.
    await expect(page.getByText(/could not be verified/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /finish/i })).toBeDisabled();
    expect(protectedUrls).toEqual([]);
    expect(await countThreads(user.id)).toBe(0);
  });

  test("onboarded session gets the product shell and history, and `/onboarding` redirects away", async ({
    page,
  }) => {
    const user = await createUser(page);

    await markOnboarded(user.id);
    await signIn(page, user);
    await page.goto("/onboarding");

    await expect(page).toHaveURL(/\/$/u);
    await expect(page.getByText(/what can i help with/i)).toBeVisible();
    // The transcript has no runs yet, and nothing was created by visiting `/`.
    await expect(page.getByRole("textbox")).toBeVisible();
  });

  test("sign-out returns to the landing and clears the previous account's cache", async ({
    page,
  }) => {
    const user = await createUser(page);

    await markOnboarded(user.id);
    await signIn(page, user);
    await page.goto("/");
    await expect(page.getByText(/what can i help with/i)).toBeVisible();

    await page.getByTestId("user-nav-button").click();
    // `DropdownMenuItem asChild` puts the menu role on the item itself.
    await page.getByRole("menuitem", { name: /sign out/i }).click();

    await expect(page.getByRole("button", { name: /sign in with github/i })).toBeVisible();
    await expect(page.getByText(/what can i help with/i)).toBeHidden();
  });

  test("the API session endpoint agrees with the UI gate", async ({ page }) => {
    const user = await createUser(page);

    await signIn(page, user);

    const session = await apiFetch(page, "/api/auth/get-session");

    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({
      user: { email: user.email, onboardingCompleted: false },
    });
  });
});
