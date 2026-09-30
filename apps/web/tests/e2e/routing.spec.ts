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

  test("signed-out landing follows the system light and dark theme", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");

    const landing = page.getByRole("main");
    const pixels = landing.locator("canvas");

    await expect(page.getByRole("button", { name: /sign in with github/i })).toBeVisible();
    await expect(pixels).toBeVisible();
    await expect(page.locator("html")).not.toHaveClass(/dark/u);

    const lightBackground = await landing.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );

    const lightPixels = await pixels.evaluate((element) => getComputedStyle(element).filter);

    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/dark/u);

    const darkBackground = await landing.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );

    const darkPixels = await pixels.evaluate((element) => getComputedStyle(element).filter);

    expect(lightBackground).not.toBe(darkBackground);
    expect(lightPixels).not.toBe(darkPixels);
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

  test("account settings center connections inside a full-width scroll area", async ({ page }) => {
    const user = await createUser(page);

    await markOnboarded(user.id);
    await signIn(page, user);
    await page.goto("/");

    await page.getByTestId("user-nav-button").click();
    await page.getByRole("menuitem", { name: "Settings" }).click();

    await expect(page).toHaveURL(/\/settings$/u);
    await expect(page.getByRole("heading", { name: "Connect GitHub" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Model providers" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh models" })).toHaveCount(0);

    const geometry = await page.getByTestId("settings-scroll").evaluate((element) => ({
      scrollRight: element.getBoundingClientRect().right,
      contentRight: element.firstElementChild?.getBoundingClientRect().right ?? 0,
      viewport: window.innerWidth,
    }));

    expect(Math.abs(geometry.scrollRight - geometry.viewport)).toBeLessThanOrEqual(1);
    expect(geometry.contentRight).toBeLessThan(geometry.scrollRight - 32);

    await page.setViewportSize({ width: 390, height: 500 });
    const settings = page.getByTestId("settings-scroll");

    await expect(settings).toBeVisible();

    const scroll = await settings.evaluate((element) => {
      element.scrollTop = element.scrollHeight;

      return { top: element.scrollTop, overflow: element.scrollHeight - element.clientHeight };
    });

    expect(scroll.overflow).toBeGreaterThan(0);
    expect(scroll.top).toBeGreaterThan(0);

    const root = await page.evaluate(() => ({
      scroll: document.documentElement.scrollHeight,
      viewport: window.innerHeight,
    }));

    expect(root.scroll).toBeLessThanOrEqual(root.viewport + 1);
  });

  test("account theme can return to the system setting", async ({ page }) => {
    const user = await createUser(page);

    await markOnboarded(user.id);
    await signIn(page, user);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");

    await page.getByTestId("user-nav-button").click();
    await expect(page.getByRole("menuitemradio", { name: "System" })).toBeChecked();
    await page.getByRole("menuitemradio", { name: "Light" }).click();
    await expect(page.locator("html")).not.toHaveClass(/dark/u);

    await page.getByTestId("user-nav-button").click();
    await page.getByRole("menuitemradio", { name: "System" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/u);

    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).not.toHaveClass(/dark/u);
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
