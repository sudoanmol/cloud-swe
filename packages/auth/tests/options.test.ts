import { describe, expect, test } from "bun:test";

import {
  buildAuthOptions,
  githubCredentialsFromEnv,
  requireGithubAppOAuthInProduction,
} from "../src/options";

const base = {
  secret: "local-development-only-change-this-secret",
  baseURL: "http://localhost:3000",
  trustedOrigins: ["http://localhost:3001"],
};

describe("auth options", () => {
  test("enables GitHub OAuth from server-only client credentials", () => {
    const options = buildAuthOptions({
      ...base,
      github: { clientId: "github-client-id", clientSecret: "github-client-secret" },
    });

    expect(options.socialProviders).toEqual({
      github: {
        clientId: "github-client-id",
        clientSecret: "github-client-secret",
        disableDefaultScope: true,
      },
    });
    expect(options.socialProviders?.github).not.toHaveProperty("scope");
  });

  test("reads both GitHub App client values from server env", () => {
    expect(githubCredentialsFromEnv({})).toBeUndefined();
    expect(
      githubCredentialsFromEnv({
        GITHUB_CLIENT_ID: "Iv1.github-app",
        GITHUB_CLIENT_SECRET: "github-app-secret",
      }),
    ).toEqual({
      clientId: "Iv1.github-app",
      clientSecret: "github-app-secret",
    });
    expect(() => githubCredentialsFromEnv({ GITHUB_CLIENT_ID: "Iv1.github-app" })).toThrow(
      "GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must both be set",
    );
  });

  test("production requires GitHub App OAuth credentials", () => {
    expect(() => requireGithubAppOAuthInProduction({ nodeEnv: "development" })).not.toThrow();
    expect(() =>
      requireGithubAppOAuthInProduction({
        nodeEnv: "production",
        github: { clientId: "Iv1.github-app", clientSecret: "github-app-secret" },
      }),
    ).not.toThrow();
    expect(() => requireGithubAppOAuthInProduction({ nodeEnv: "production" })).toThrow(
      "Production requires GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET from the GitHub App",
    );
  });

  test("omits GitHub when server credentials are absent", () => {
    const options = buildAuthOptions(base);

    expect(options.socialProviders?.github).toBeUndefined();
  });

  test("keeps cross-origin session cookies httpOnly, Secure, and SameSite=None", () => {
    const options = buildAuthOptions(base);

    expect(options.advanced?.defaultCookieAttributes).toEqual({
      sameSite: "none",
      secure: true,
      httpOnly: true,
    });
  });

  test("keeps email and password for local accounts", () => {
    const options = buildAuthOptions(base);

    expect(options.emailAndPassword).toEqual({ enabled: true });
  });
});
