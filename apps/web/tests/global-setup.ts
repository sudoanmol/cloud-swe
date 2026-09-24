import { execFileSync } from "node:child_process";
import { Client } from "pg";
import { z } from "zod";

/**
 * Disposable database for the browser suite: dropped, recreated, migrated.
 *
 * Seeding users and onboarding happens per test through test-only helpers, so
 * this only guarantees an empty schema for the API to start against.
 */
const ADMIN_URL =
  process.env.E2E_ADMIN_DATABASE_URL ?? "postgresql://postgres:password@127.0.0.1:5432/postgres";

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgresql://postgres:password@127.0.0.1:5432/cloud_swe_web_e2e";

const DATABASE_NAME = z
  .string()
  .regex(
    /^cloud_swe_web_e2e(?:_[a-z0-9_]+)?$/,
    "Refusing to reset a database outside the cloud_swe_web_e2e namespace",
  )
  .parse(new URL(DATABASE_URL).pathname.slice(1));

/** The sandbox image the executed-flow specs need, built once per run. */
function ensureRunnerImage(): void {
  if (process.env.E2E_WITH_RUNNER !== "1") return;

  const image = process.env.E2E_RUNNER_IMAGE ?? "cloud-swe-web-tests";

  execFileSync(
    "docker",
    ["build", "-t", image, "-f", "tests/fixtures/runner-image.Dockerfile", "tests/fixtures"],
    { cwd: process.cwd(), stdio: "inherit" },
  );
}

export default async function globalSetup(): Promise<void> {
  ensureRunnerImage();

  const admin = new Client({ connectionString: ADMIN_URL });

  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${DATABASE_NAME}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${DATABASE_NAME}"`);
  await admin.end();

  execFileSync("bunx", ["drizzle-kit", "migrate"], {
    cwd: "../../packages/db",
    env: { ...process.env, DATABASE_URL },
    stdio: "inherit",
  });
}
