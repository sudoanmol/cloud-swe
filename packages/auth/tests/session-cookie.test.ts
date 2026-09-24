import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Client, Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";

import { createAuth } from "../src/index";

/**
 * Real Better Auth 1.7.1 cookie round trip.
 *
 * Creates a disposable database, signs up through the HTTP handler, then
 * verifies: the signed `session_data` cookie cache returns the onboarding
 * field, `disableCookieCache` reads database truth and refreshes the cookie,
 * and API authorization rejects a revoked session even while the cached cookie
 * is still fresh.
 */
const database = `auth_cookie_${randomUUID().replaceAll("-", "")}`;

const baseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:password@localhost:5432/cloud-swe";

const authBaseUrl = "http://localhost:3000";

const migrationsFolder = fileURLToPath(new URL("../../db/src/migrations", import.meta.url));

let admin: Client;

let pool: Pool;

let auth: ReturnType<typeof createAuth>;

const userIds: string[] = [];

beforeAll(async () => {
  admin = new Client({ connectionString: baseUrl });

  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  const url = new URL(baseUrl);

  url.pathname = `/${database}`;
  pool = new Pool({ connectionString: url.toString(), max: 4 });
  await migrate(drizzle(pool), { migrationsFolder });
  auth = createAuth({
    database: drizzle(pool),
    secret: "test-secret-that-is-at-least-32-characters",
    baseURL: authBaseUrl,
    trustedOrigins: ["http://localhost:3001"],
    github: { clientId: "client", clientSecret: "secret" },
  });
});

afterAll(async () => {
  await pool?.end();
  await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin?.end();
});

function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

/** Merge refreshed cookies over an existing cookie header, by name. */
function mergeCookies(existing: string, refreshed: Response): string {
  const values = new Map<string, string>();

  for (const pair of existing.split("; ")) {
    const [name] = pair.split("=");

    if (name) values.set(name, pair);
  }

  for (const cookie of refreshed.headers.getSetCookie()) {
    const pair = cookie.split(";")[0] ?? "";
    const [name] = pair.split("=");

    if (name) values.set(name, pair);
  }

  return [...values.values()].join("; ");
}

function sessionRequest(path: string, cookie: string) {
  return auth.handler(
    new Request(`${authBaseUrl}${path}`, {
      headers: { cookie, origin: "http://localhost:3001" },
    }),
  );
}

async function signUp(): Promise<{ userId: string; cookie: string }> {
  const email = `cookie-${randomUUID()}@example.test`;

  const response = await auth.handler(
    new Request(`${authBaseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3001" },
      body: JSON.stringify({ email, password: "changeme-test-password", name: "Cookie User" }),
    }),
  );

  expect(response.status).toBe(200);

  const body = sessionBodySchema.parse(await response.json());

  if (!body) throw new Error("Sign-up returned no session");

  userIds.push(body.user.id);

  return { userId: body.user.id, cookie: cookiesFrom(response) };
}

const sessionBodySchema = z
  .object({
    user: z.object({ id: z.string(), onboardingCompleted: z.boolean().optional() }),
  })
  .nullable();

describe("Better Auth session cookie round trip", () => {
  test("cookie cache carries onboardingCompleted and disables writes until refreshed", async () => {
    const { userId, cookie } = await signUp();
    // Sign-up returns the signed `session_data` cookie cache alongside the
    // opaque session token.
    const cachedCookie = cookie;

    expect(cachedCookie).toContain("session_data");

    const primed = await sessionRequest("/api/auth/get-session", cachedCookie);

    expect(primed.status).toBe(200);

    const primedBody = sessionBodySchema.parse(await primed.json());

    expect(primedBody?.user.onboardingCompleted).toBe(false);

    // Database truth changes without a cookie refresh.
    await pool.query('update "user" set onboarding_completed = true where id = $1', [userId]);

    const stale = await sessionRequest("/api/auth/get-session", cachedCookie);

    expect(sessionBodySchema.parse(await stale.json())?.user.onboardingCompleted).toBe(false);

    // disableCookieCache reads the database and returns a fresh Set-Cookie.
    const refreshed = await sessionRequest(
      "/api/auth/get-session?disableCookieCache=true",
      cachedCookie,
    );

    const refreshedBody = sessionBodySchema.parse(await refreshed.json());

    expect(refreshedBody?.user.onboardingCompleted).toBe(true);
    // This is exactly the response `apps/server` forwards to the browser.
    expect(refreshed.headers.getSetCookie().length).toBeGreaterThan(0);

    const refreshedCookie = mergeCookies(cachedCookie, refreshed);
    const fromFreshCache = await sessionRequest("/api/auth/get-session", refreshedCookie);

    expect(sessionBodySchema.parse(await fromFreshCache.json())?.user.onboardingCompleted).toBe(
      true,
    );
  });

  test("a revoked database session is rejected despite a fresh cookie cache", async () => {
    const { userId, cookie } = await signUp();
    const primed = await sessionRequest("/api/auth/get-session", cookie);
    const cachedCookie = cookie;

    expect(sessionBodySchema.parse(await primed.json())?.user.id).toBe(userId);

    // Delete every session row for this user, as sign-out/revocation would.
    await pool.query('delete from "session" where user_id = $1', [userId]);

    // API authorization path: database truth, cookie cache bypassed.
    const authorized = await (
      await sessionRequest("/api/auth/get-session?disableCookieCache=true", cachedCookie)
    ).json();

    expect(authorized).toBeNull();
  });
});
