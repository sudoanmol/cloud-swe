import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import * as schema from "@cloud-swe/db/schema/auth";

import { buildAuthOptions, type AuthSettings } from "./options";

export type AuthDatabase = Parameters<typeof drizzleAdapter>[0];

export interface CreateAuthOptions extends AuthSettings {
  database: AuthDatabase;
}

export function createAuth(options: CreateAuthOptions) {
  return betterAuth({
    ...buildAuthOptions(options),
    database: drizzleAdapter(options.database, {
      provider: "pg",
      schema,
    }),
  });
}

export {
  buildAuthOptions,
  githubCredentialsFromEnv,
  requireGithubAppOAuthInProduction,
  type AuthSettings,
  type GithubCredentials,
} from "./options";
