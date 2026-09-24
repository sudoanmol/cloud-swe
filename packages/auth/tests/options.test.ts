import { describe, expect, test } from "bun:test";

import { buildAuthOptions, type AuthSettings } from "../src/options";

const settings: AuthSettings = {
  secret: "a".repeat(32),
  baseURL: "http://localhost:3000",
  trustedOrigins: ["http://localhost:3001"],
};

describe("auth options", () => {
  test("declares the server-owned onboarding field as non-writable", () => {
    const options = buildAuthOptions(settings);

    const field = options.user?.additionalFields?.onboardingCompleted;
    expect(field).toMatchObject({
      type: "boolean",
      required: false,
      defaultValue: false,
      input: false,
    });

    // Compile-time guarantee that `input` stays the literal `false`; the
    // inferred client input type excludes the field when it does.
    const input = field?.input;
    // @ts-expect-error onboardingCompleted cannot be set through client auth input
    const writable: typeof input = true;
    void writable;
    expect(field?.input).toBe(false);
  });

  test("enables a short signed session cookie cache without dropping database sessions", () => {
    const options = buildAuthOptions(settings);

    expect(options.session?.cookieCache).toEqual({ enabled: true, maxAge: 60 });
    // No secondary storage / stateless mode is configured.
    expect(options.session).not.toHaveProperty("storeSessionInDatabase", false);
  });

  test("keeps secure HttpOnly cookies and exact trusted origins", () => {
    const options = buildAuthOptions(settings);

    expect(options.advanced?.defaultCookieAttributes).toEqual({
      sameSite: "none",
      secure: true,
      httpOnly: true,
    });
    expect(options.trustedOrigins).toEqual(["http://localhost:3001"]);
  });

  test("adds GitHub only when credentials are present", () => {
    expect("socialProviders" in buildAuthOptions(settings)).toBe(false);

    const withGithub = buildAuthOptions({
      ...settings,
      github: { clientId: "client", clientSecret: "secret" },
    });

    const github = "socialProviders" in withGithub ? withGithub.socialProviders.github : undefined;

    expect(github).toMatchObject({ clientId: "client", disableDefaultScope: true });
  });
});
