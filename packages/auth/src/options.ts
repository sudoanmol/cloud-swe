import type { BetterAuthOptions } from "better-auth";

export type GithubCredentials = {
  clientId: string;
  clientSecret: string;
};

export type AuthSettings = {
  secret: string;
  baseURL: string;
  trustedOrigins: readonly string[];
  github?: GithubCredentials;
};

/**
 * Server-owned onboarding flag. `input: false` keeps it out of client auth
 * input, and the literal `false` is required so the inferred client user type
 * omits it from writable fields.
 */
const onboardingCompletedField = {
  type: "boolean",
  required: false,
  defaultValue: false,
  input: false,
} as const;

export function githubCredentialsFromEnv(env: {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}): GithubCredentials | undefined {
  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;

  if (clientId && clientSecret) return { clientId, clientSecret };

  if (clientId || clientSecret) {
    throw new Error("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must both be set");
  }

  return undefined;
}

export function requireGithubAppOAuthInProduction(input: {
  nodeEnv: string;
  github?: GithubCredentials;
}): void {
  if (input.nodeEnv === "production" && !input.github) {
    throw new Error(
      "Production requires GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET from the GitHub App",
    );
  }
}

/**
 * Returns a `satisfies`-checked literal so `createAuth`'s return type keeps
 * literal `additionalFields` and the client can infer the user model without
 * duplicating it.
 */
export function buildAuthOptions(settings: AuthSettings) {
  const base = {
    account: { encryptOAuthTokens: true },
    trustedOrigins: [...settings.trustedOrigins],
    emailAndPassword: {
      enabled: true,
    },
    secret: settings.secret,
    baseURL: settings.baseURL,
    advanced: {
      defaultCookieAttributes: {
        sameSite: "none",
        secure: true,
        httpOnly: true,
      },
    },
    user: {
      additionalFields: {
        onboardingCompleted: onboardingCompletedField,
      },
    },
    session: {
      // UI optimization only. API authorization always reads database sessions.
      cookieCache: { enabled: true, maxAge: 60 },
    },
  } satisfies Omit<BetterAuthOptions, "database">;

  if (!settings.github) return base;

  return {
    ...base,
    socialProviders: {
      github: {
        clientId: settings.github.clientId,
        clientSecret: settings.github.clientSecret,
        // GitHub App tokens do not use OAuth scopes.
        disableDefaultScope: true,
      },
    },
  } satisfies Omit<BetterAuthOptions, "database">;
}
