/**
 * Test-only Fastify host for the browser suite.
 *
 * It builds the real server (`buildServer` + `registerApiRoutes`) and injects a
 * fixture GitHub client at the server boundary, so repository selection and
 * onboarding readiness work without a live GitHub App. Nothing here is a
 * production route: the production entry point (`src/index.ts`) is unchanged and
 * still builds its client from real credentials, and no fixture env knob exists
 * in production code.
 *
 * Started by `apps/web/playwright.config.ts` on the browser suite's API port.
 */
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import {
  AttachmentObjectNotFoundError,
  type AttachmentObjectStore,
} from "@cloud-swe/db/attachment-objects";
import { createAuth, githubCredentialsFromEnv } from "@cloud-swe/auth";
import { createDb } from "@cloud-swe/db";
import { createModelCredentialStore } from "@cloud-swe/db/model-credentials";
import { createOnboardingStore } from "@cloud-swe/db/onboarding";
import { createThreadStore } from "@cloud-swe/db/threads";
import { createGitStore } from "@cloud-swe/db/git-store";
import { env as authEnv } from "@cloud-swe/env/auth";
import { env as databaseEnv } from "@cloud-swe/env/database";
import { env } from "@cloud-swe/env/server";
import { createGithubClient, type GithubClient } from "@cloud-swe/api/github";
import { Pool } from "pg";

import { buildServer } from "../src/app";

const fixtureRepository = {
  id: 1,
  fullName: "fixture-org/fixture-repo",
  owner: "fixture-org",
  name: "fixture-repo",
  private: false,
  defaultBranch: "main",
  empty: false,
};

const secondInstallation = {
  accountLogin: "second-org",
  accountType: "Organization",
  appId: 42,
  appSlug: authEnv.GITHUB_APP_SLUG ?? "cloud-swe",
  id: 5252,
  repositorySelection: "selected",
  suspended: false,
  targetType: "Organization",
};

/** One installation's repository list spans two GitHub pages. */
function fixtureRepositoryPage(installationId: number, page: number) {
  if (installationId === secondInstallation.id)
    return {
      items: [
        {
          defaultBranch: "main",
          empty: false,
          fullName: "second-org/only-repo",
          id: 900,
          name: "only-repo",
          owner: "second-org",
          private: false,
        },
      ],
      nextPage: null,
    };

  if (page > 2) return { items: [], nextPage: null };

  const emptyRepository = {
    defaultBranch: "main",
    empty: true,
    fullName: "fixture-org/empty-repo",
    id: 700,
    name: "empty-repo",
    owner: "fixture-org",
    private: false,
  };

  if (page === 2)
    return {
      items: [50, 51].map((number) => ({
        defaultBranch: "main",
        empty: false,
        fullName: `fixture-org/fixture-repo-${String(number).padStart(3, "0")}`,
        id: 1000 + number,
        name: `fixture-repo-${String(number).padStart(3, "0")}`,
        owner: "fixture-org",
        private: false,
      })),
      nextPage: null,
    };

  const start = 2;

  const items = Array.from({ length: 48 }, (_, index) => {
    const number = start + index;

    return {
      defaultBranch: "main",
      empty: false,
      fullName: `fixture-org/fixture-repo-${String(number).padStart(3, "0")}`,
      id: 1000 + number,
      name: `fixture-repo-${String(number).padStart(3, "0")}`,
      owner: "fixture-org",
      private: false,
    };
  });

  return { items: [fixtureRepository, emptyRepository, ...items], nextPage: 2 };
}

/** Branch listings also page, so the picker cannot assume one response. */
function fixtureBranchPage(repositoryUrl: string, page: number) {
  const name = repositoryUrl.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");

  if (name !== "fixture-org/fixture-repo")
    return { items: fixtureBranches.slice(0, 1), nextPage: null };

  if (page === 1)
    return {
      items: [
        ...fixtureBranches,
        ...Array.from({ length: 48 }, (_, index) => ({
          commit: {
            sha: String(index + 2)
              .repeat(40)
              .slice(0, 40),
            url: "",
          },
          name: `topic/${index + 1}`,
          protected: false,
        })),
      ],
      nextPage: 2,
    };

  if (page === 2)
    return {
      items: Array.from({ length: 10 }, (_, index) => ({
        commit: {
          sha: String(index + 60)
            .repeat(40)
            .slice(0, 40),
          url: "",
        },
        name: `release/${index + 1}`,
        protected: false,
      })),
      nextPage: null,
    };

  return { items: [], nextPage: null };
}

const fixtureInstallation = {
  accountLogin: "fixture-org",
  accountType: "Organization",
  appId: 42,
  appSlug: authEnv.GITHUB_APP_SLUG ?? "cloud-swe",
  id: 4242,
  repositorySelection: "selected",
  suspended: false,
  targetType: "Organization",
};

const fixtureBranches = [
  {
    commit: {
      sha: "0".repeat(40),
      url: "https://api.github.com/repos/fixture-org/fixture-repo/commits/0",
    },
    name: "main",
    protected: true,
  },
  {
    commit: {
      sha: "1".repeat(40),
      url: "https://api.github.com/repos/fixture-org/fixture-repo/commits/1",
    },
    name: "feature/one",
    protected: false,
  },
];

/**
 * A `GithubClient` whose user lookup always succeeds and whose metadata comes
 * from the fixture above. The fixture is the external boundary; everything
 * downstream (readiness verification, repository listing, branch listing) is the
 * real implementation.
 */
function createFixtureGithubClient(): GithubClient {
  const real = createGithubClient(async () => "fixture-access-token");

  return {
    ...real,
    installations: async () => ({
      items: [fixtureInstallation, secondInstallation],
      nextPage: null,
    }),
    installationRepositories: async (_userId, installationId, page) =>
      fixtureRepositoryPage(installationId, page),
    branches: async (_userId, url, page) => fixtureBranchPage(url, page),
    repository: async () => ({
      clone_url: "https://github.com/fixture-org/fixture-repo.git",
      default_branch: "main",
      full_name: "fixture-org/fixture-repo",
      html_url: "https://github.com/fixture-org/fixture-repo",
      id: 1,
      name: "fixture-repo",
      permissions: { pull: true, push: false },
      private: false,
    }),
  };
}

const pool = new Pool({ connectionString: databaseEnv.DATABASE_URL });

pool.on("connect", (client) => client.on("error", () => undefined));

const database = createDb(pool);

const encryptionKey = env.MODEL_CREDENTIALS_ENCRYPTION_KEY;

if (!encryptionKey)
  throw new Error("MODEL_CREDENTIALS_ENCRYPTION_KEY is required for the e2e host");

const github = githubCredentialsFromEnv({
  GITHUB_CLIENT_ID: authEnv.GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET: authEnv.GITHUB_CLIENT_SECRET,
});

const auth = createAuth({
  database,
  secret: authEnv.BETTER_AUTH_SECRET,
  baseURL: authEnv.BETTER_AUTH_URL,
  trustedOrigins: [env.CORS_ORIGIN],
  github: github ?? { clientId: "fixture-client", clientSecret: "fixture-secret" },
});

const authProvider = {
  getSession: async (headers: Headers) => {
    const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } });

    if (!session) return null;

    return {
      session: session.session,
      user: { emailVerified: session.user.emailVerified, id: session.user.id },
    };
  },
  handler: (request: Request) => auth.handler(request),
};

const store = createThreadStore(database, {
  primaryGithubAccountId: env.PRIMARY_GITHUB_ACCOUNT_ID,
});

const onboardingStore = createOnboardingStore(database);

const gitStore = createGitStore(database);

const fixtureGithub = createFixtureGithubClient();

async function refreshSessionCookies(request: {
  headers: Record<string, string | string[] | undefined>;
}): Promise<string[]> {
  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }

  const url = new URL("/api/auth/get-session", authEnv.BETTER_AUTH_URL);

  url.searchParams.set("disableCookieCache", "true");
  const response = await auth.handler(new Request(url.toString(), { headers, method: "GET" }));

  await response.arrayBuffer();

  return response.headers.getSetCookie();
}

// Only the external object service is replaced. Multipart parsing, limits,
// image processing, ownership and metadata persistence use production code.
const objectBytes = new Map<string, Uint8Array>();

const attachmentObjects: AttachmentObjectStore = {
  async put({ key, body }) {
    objectBytes.set(key, body instanceof Uint8Array ? Buffer.from(body) : await buffer(body));
  },
  get(key) {
    const bytes = objectBytes.get(key);

    return bytes
      ? Promise.resolve(Readable.from([bytes]))
      : Promise.reject(new AttachmentObjectNotFoundError());
  },
  delete(keys) {
    for (const key of keys) objectBytes.delete(key);

    return Promise.resolve();
  },
};

const server = buildServer({
  attachmentObjects,
  attachmentStore: store,
  auth: authProvider,
  allowUnverifiedCompute: true,
  computeAccess: async () => ({ owner: false, trusted: true }),
  githubRead: { appSlug: authEnv.GITHUB_APP_SLUG, github: fixtureGithub, store: gitStore },
  modelCredentials: (userId) => createModelCredentialStore(database, userId, encryptionKey),
  nodeEnv: "test",
  onboarding: {
    appSlug: authEnv.GITHUB_APP_SLUG,
    github: fixtureGithub,
    refreshSession: refreshSessionCookies,
    store: onboardingStore,
  },
  pollMs: env.SSE_POLL_MS,
  heartbeatMs: env.SSE_HEARTBEAT_MS,
  requireModelSelection: true,
  runLimit: env.MAX_ACTIVE_RUNS,
  store,
  trustedOrigins: [env.CORS_ORIGIN],
});

server.addHook("onClose", async () => {
  await pool.end();
});

// `listen` resolves to the bound address URL, which is the readiness signal for
// the browser suite's webServer probe.
const address = await server.listen({ host: "127.0.0.1", port: env.PORT });

server.log.info({ address }, "e2e fixture host listening");
