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

export function buildAuthOptions(settings: AuthSettings): Omit<BetterAuthOptions, "database"> {
  const options: Omit<BetterAuthOptions, "database"> = {
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
  };

  if (settings.github) {
    options.socialProviders = {
      github: {
        clientId: settings.github.clientId,
        clientSecret: settings.github.clientSecret,
        // GitHub App tokens do not use OAuth scopes.
        disableDefaultScope: true,
      },
    };
  }

  return options;
}
