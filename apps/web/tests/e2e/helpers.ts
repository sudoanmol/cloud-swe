import { expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { z } from "zod";

/**
 * Test-only fixture setup. These helpers talk to the API's real auth endpoints
 * and to PostgreSQL directly; they never add a product route, a bypass or a
 * fake backend response.
 */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:3210";

/** The trusted origin the auth server expects on cookie-authenticated requests. */
export const WEB_ORIGIN = process.env.E2E_WEB_ORIGIN ?? "http://127.0.0.1:3310";

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgresql://postgres:password@127.0.0.1:5432/cloud_swe_web_e2e";

const signUpResponseSchema = z.object({ user: z.object({ id: z.string() }) });

/** Any JSON body the API returns; the caller narrows it. */
const jsonBodySchema = z.unknown();

export type TestUser = { id: string; email: string; password: string };

let counter = 0;

function uniqueEmail(): string {
  counter += 1;

  return `e2e-${Date.now()}-${counter}@example.test`;
}

export type ApiResult = { status: number; body: unknown };

/**
 * Layout geometry check: a 390 px phone must not scroll sideways. The screenshot
 * is kept for review, and the assertion fails on real overflow.
 */
export async function expectNoHorizontalOverflow(page: Page, label: string, path: string) {
  const metrics = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));

  expect(
    metrics.scroll,
    `${label}: ${metrics.scroll}px scroll width vs ${metrics.client}px`,
  ).toBeLessThanOrEqual(metrics.client + 1);
  await page.screenshot({ path });
}

/**
 * Calls the API from inside the page so the browser attaches the session's own
 * cookies: they are `Secure; SameSite=None`, which a loopback origin may set but
 * Playwright's request context would not replay.
 */
export async function apiFetch(
  page: Page,
  path: string,
  init: { method?: string; json?: unknown; csrf?: boolean } = {},
): Promise<ApiResult> {
  const response = await page.evaluate(
    async (input) => {
      const headers: Record<string, string> = {};

      if (input.json !== undefined) headers["content-type"] = "application/json";

      if (input.csrf) headers["x-csrf-protection"] = "1";

      const result = await fetch(`${input.base}${input.path}`, {
        body: input.json === undefined ? undefined : JSON.stringify(input.json),
        credentials: "include",
        headers,
        method: input.method ?? "GET",
      });

      return {
        contentType: result.headers.get("content-type") ?? "",
        status: result.status,
        text: await result.text(),
      };
    },
    { base: API_URL, csrf: init.csrf === true, json: init.json, method: init.method, path },
  );

  // JSON is parsed back in Node; the page only reports bytes and status.
  if (!response.contentType.includes("json"))
    return { body: response.text, status: response.status };

  const json = jsonBodySchema.safeParse(JSON.parse(response.text));

  return { body: json.success ? json.data : response.text, status: response.status };
}

/** Signs a user up through Better Auth's own handler, exactly as a client would. */
export async function createUser(page: Page): Promise<TestUser> {
  const email = uniqueEmail();

  // A real origin is required before anything is called from the page: an
  // `about:blank` document cannot send or receive credentialed requests.
  if (new URL(page.url() || "about:blank", WEB_ORIGIN).origin !== WEB_ORIGIN) await page.goto("/");

  const password = "changeme-test-password";

  const response = await page.request.post(`${API_URL}/api/auth/sign-up/email`, {
    data: { email, name: "E2E User", password },
    headers: { origin: WEB_ORIGIN },
  });

  if (!response.ok())
    throw new Error(`sign-up failed: ${response.status()} ${await response.text()}`);

  const body = signUpResponseSchema.parse(await response.json());

  return { email, id: body.user.id, password };
}

export async function signIn(page: Page, user: TestUser): Promise<void> {
  const response = await page.request.post(`${API_URL}/api/auth/sign-in/email`, {
    data: { email: user.email, password: user.password },
    headers: { origin: WEB_ORIGIN },
  });

  if (!response.ok())
    throw new Error(`sign-in failed: ${response.status()} ${await response.text()}`);
}

/** Completion truth lives in the database; only the onboarding route may set it. */
export async function markOnboarded(userId: string): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL });

  await client.connect();
  await client.query(`update "user" set onboarding_completed = true where id = $1`, [userId]);
  await client.end();
}

export async function countThreads(userId: string): Promise<number> {
  const client = new Client({ connectionString: DATABASE_URL });

  await client.connect();

  const result = await client.query<{ count: string }>(
    `select count(*)::text as count from thread where user_id = $1`,
    [userId],
  );

  await client.end();

  return Number(result.rows[0]?.count ?? "0");
}
