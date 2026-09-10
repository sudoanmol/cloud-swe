import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import * as schema from "@cloud-swe/db/schema/auth";

export type AuthDatabase = Parameters<typeof drizzleAdapter>[0];

export interface CreateAuthOptions {
  database: AuthDatabase;
  secret: string;
  baseURL: string;
  trustedOrigins: readonly string[];
}

export function createAuth(options: CreateAuthOptions) {
  return betterAuth({
    database: drizzleAdapter(options.database, {
      provider: "pg",
      schema,
    }),
    trustedOrigins: [...options.trustedOrigins],
    emailAndPassword: {
      enabled: true,
    },
    secret: options.secret,
    baseURL: options.baseURL,
    advanced: {
      defaultCookieAttributes: {
        sameSite: "none",
        secure: true,
        httpOnly: true,
      },
    },
    plugins: [],
  });
}
