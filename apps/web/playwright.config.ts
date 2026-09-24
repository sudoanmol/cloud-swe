import { defineConfig, devices } from "@playwright/test";

/**
 * Browser suite against the real Fastify API and a real Better Auth session.
 *
 * There is no Next-side backend, no auth bypass and no synthetic stream: the
 * API runs on its own port against a disposable database, and the Next build
 * talks to it through `NEXT_PUBLIC_API_URL`. GitHub metadata comes from a
 * fixture client injected by the test-only host; set `E2E_WITH_RUNNER=1` to also
 * start the real dispatcher and worker.
 */
const API_PORT = Number(process.env.E2E_API_PORT ?? 3210);

const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3310);

const apiUrl = `http://127.0.0.1:${API_PORT}`;

const webUrl = `http://127.0.0.1:${WEB_PORT}`;

const databaseUrl =
  process.env.E2E_DATABASE_URL ?? "postgresql://postgres:password@127.0.0.1:5432/cloud_swe_web_e2e";

const runnerPort = Number(process.env.E2E_RUNNER_PORT ?? 3311);

type WebServer = NonNullable<Parameters<typeof defineConfig>[0]["webServer"]>;

/**
 * Child processes get a string-only environment: an inherited `undefined` value
 * is not the same as an unset variable, and Playwright's types reject it.
 */
function childEnv(overrides: Record<string, string>) {
  const environment = new Map(Object.entries(overrides));

  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined) environment.set(name, value);

  return Object.fromEntries(environment);
}

/**
 * Real dispatcher + worker, so submitted runs execute instead of staying
 * queued. Off by default: it needs the isolated Temporal/Postgres ports and the
 * local scripted sandbox image.
 */
const runnerServer: WebServer =
  process.env.E2E_WITH_RUNNER === "1"
    ? [
        {
          command: "bun run apps/web/tests/support/runner-fixture.ts",
          cwd: "../..",
          env: childEnv({
            DATABASE_URL: databaseUrl,
            E2E_RUNNER_PORT: String(runnerPort),
            E2E_TASK_QUEUE: process.env.E2E_TASK_QUEUE ?? "e2e-web",
            RUNNER_EXECUTION_MODE: "scripted",
            RUNNER_SANDBOX_PROVIDER: "docker",
            RUNNER_DOCKER_IMAGE: process.env.E2E_RUNNER_IMAGE ?? "cloud-swe-web-tests",
            RUNNER_IDLE_PAUSE_MS: "2000",
            RUNNER_CLEANUP_MS: "5000",
            RUNNER_MAX_RUN_MS: "60000",
            RUNNER_STEP_DELAY_MS: "1000",
            SSE_POLL_MS: "50",
            SSE_HEARTBEAT_MS: "500",
            TEMPORAL_ADDRESS: process.env.E2E_TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
          }),
          reuseExistingServer: false,
          stderr: "pipe",
          stdout: "pipe",
          timeout: 120_000,
          url: `http://127.0.0.1:${runnerPort}/`,
        },
      ]
    : [];

export default defineConfig({
  expect: { timeout: 30_000 },
  forbidOnly: !!process.env.CI,
  fullyParallel: false,
  globalSetup: "./tests/global-setup.ts",
  projects: [
    { name: "e2e", testMatch: /e2e\/.*\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
  ],
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  retries: 0,
  testDir: "./tests",
  timeout: 120_000,
  use: {
    baseURL: webUrl,
    trace: "retain-on-failure",
  },
  webServer: [
    ...runnerServer,
    {
      // Test-only host: real routes plus a fixture GitHub client injected at the
      // server boundary. The production entry point is untouched.
      command: `bun run tests/e2e-host.ts`,
      cwd: "../server",
      env: childEnv({
        BETTER_AUTH_URL: apiUrl,
        BETTER_AUTH_SECRET: "e2e-secret-that-is-at-least-32-characters",
        DATABASE_URL: databaseUrl,
        GITHUB_APP_ID: "",
        GITHUB_APP_PRIVATE_KEY: "",
        GITHUB_APP_SLUG: "",
        GITHUB_CLIENT_ID: "",
        GITHUB_CLIENT_SECRET: "",
        GIT_BROKER_SECRET: "",
        GIT_BROKER_STORAGE: "",
        GIT_BROKER_URL: "",
        // 32-byte hex key, the shape the credential store requires.
        MODEL_CREDENTIALS_ENCRYPTION_KEY:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        CORS_ORIGIN: webUrl,
        // The no-worker suite deliberately leaves runs queued, so the shared
        // active-run guard would otherwise trip; the env ceiling is 10.
        MAX_ACTIVE_RUNS: "10",
        PORT: String(API_PORT),
        // The API starts the durable workflow, so it must address the same
        // Temporal and the same task queue as the worker below.
        TEMPORAL_ADDRESS: process.env.E2E_TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
        TEMPORAL_TASK_QUEUE: process.env.E2E_TASK_QUEUE ?? "e2e-web",
      }),
      reuseExistingServer: false,
      stderr: "pipe",
      stdout: "pipe",
      timeout: 120_000,
      // The API has no `/ping`; the readiness URL is its real root route.
      url: `${apiUrl}/`,
    },
    {
      // Build then serve: the API origin is inlined into the client bundle at
      // build time, so the suite builds against the same value it asserts on.
      command: `bunx next build && bunx next start --port ${WEB_PORT}`,
      env: childEnv({ NEXT_PUBLIC_API_URL: apiUrl }),
      reuseExistingServer: false,
      stderr: "pipe",
      stdout: "pipe",
      timeout: 180_000,
      url: webUrl,
    },
  ],
  workers: 1,
});
