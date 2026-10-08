import { describe, expect, test } from "bun:test";
import Fastify from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";

import type { OnboardingStore } from "@cloud-swe/db/onboarding";
import {
  ThreadStoreError,
  type ThreadEvent,
  type ThreadView,
} from "@cloud-swe/db/thread-contracts";
import type { CredentialInfo } from "@earendil-works/pi-ai";

import { onboardingResponseSchema } from "../src/contracts";
import { registerApiRoutes } from "../src/routes";
import type { ModelCredentials, ThreadRouteStore } from "../src/routers/thread";
import { verifyGithubReadiness, type GithubReadinessClient } from "../src/routers/onboarding";

const origin = "http://127.0.0.1:3001";

const userId = "user-1";

type Installation = Awaited<ReturnType<GithubReadinessClient["installations"]>>["items"][number];

function installation(id: number, overrides: Partial<Installation> = {}): Installation {
  return {
    id,
    accountLogin: `account-${id}`,
    accountType: "User",
    targetType: "User",
    appId: 42,
    appSlug: "cloud-swe",
    suspended: false,
    repositorySelection: "selected",
    ...overrides,
  };
}

function repository(fullName: string) {
  return {
    id: 1,
    fullName,
    owner: fullName.split("/")[0] ?? fullName,
    name: fullName.split("/")[1] ?? fullName,
    private: false,
    defaultBranch: "main",
    empty: false,
  };
}

const foreignInstallation = installation(9, { appSlug: "some-other-app" });

type GithubScript = {
  installations: (page: number) => Promise<{ items: Installation[]; nextPage: number | null }>;
  repositories: (
    installationId: number,
    page: number,
  ) => Promise<{ items: ReturnType<typeof repository>[]; nextPage: number | null }>;
};

function fakeGithub(script: GithubScript): GithubReadinessClient {
  return {
    installations: (_userId, page) => script.installations(page),
    installationRepositories: (_userId, installationId, page) =>
      script.repositories(installationId, page),
  };
}

function fakeOnboardingStore(initial: boolean) {
  const state = { completed: initial, cleared: 0, completedCalls: 0 };

  const store: OnboardingStore = {
    async readState() {
      return { completed: state.completed };
    },
    async complete() {
      state.completedCalls += 1;

      if (!state.completed) state.completed = true;

      return { completed: true };
    },
    async clear() {
      state.cleared += 1;
      state.completed = false;
    },
  };

  return { store, state };
}

function credentials(connected: { value: boolean }): ModelCredentials {
  // SAFETY: This double implements every member the onboarding routes call;
  // the credential store's generic modify signature is not exercised here.
  return () =>
    ({
      read: async () => undefined,
      list: async (): Promise<readonly CredentialInfo[]> =>
        connected.value ? [{ providerId: "openrouter", type: "api_key" }] : [],
      modify: async (_provider: string, update: (current: undefined) => Promise<undefined>) =>
        update(undefined),
      delete: async () => undefined,
    }) as never;
}

function threadStore(): ThreadRouteStore {
  const threadId = randomUUID();
  const runId = randomUUID();

  return {
    listThreads: async () => [],
    submitThread: async () => ({ threadId, runId }),
    submitMessage: async () => ({ threadId, runId }),
    getThread: async () =>
      ({
        id: threadId,
        userId,
        title: null,
        repositoryUrl: null,
        repositoryBranch: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        messages: [],
        runs: [],
        workspace: null,
        latestEventId: null,
      }) satisfies ThreadView,
    authorizeThread: async () => undefined,
    listEvents: async (): Promise<ThreadEvent[]> => [],
    requestCancel: async () => undefined,
    listQuestionRequests: async () => [],
    renameThread: async () => undefined,
    updatePendingMessage: async () => undefined,
    startQueuedMessage: async () => {
      throw new Error("unused");
    },
    deleteThread: async () => undefined,
    answerQuestionRequest: async () => {
      throw new ThreadStoreError("UNUSED", "unused");
    },
  };
}

type HarnessOptions = {
  github?: GithubReadinessClient;
  completed?: boolean;
  providerConnected?: boolean;
  refreshCookies?: string[];
  /** `null` simulates a server with no configured GitHub App slug. */
  appSlug?: string | null;
};

async function listen(options: HarnessOptions = {}) {
  const onboarding = fakeOnboardingStore(options.completed ?? false);
  const providerConnected = { value: options.providerConnected ?? true };
  const app = Fastify({ logger: false });

  registerApiRoutes(app, {
    auth: {
      getSession: async () => ({ user: { id: userId, emailVerified: true }, session: {} }),
      handler: async () => Response.json({ ok: true }),
    },
    store: threadStore(),
    modelCredentials: credentials(providerConnected),
    onboarding: {
      store: onboarding.store,
      github: options.github,
      appSlug: options.appSlug === null ? undefined : (options.appSlug ?? "cloud-swe"),
      refreshSession: async () => options.refreshCookies ?? ["session_data=fresh; Path=/"],
    },
    trustedOrigins: [origin],
    nodeEnv: "test",
    allowUnverifiedCompute: true,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const bound = z.object({ port: z.number() }).parse(app.server.address());

  return {
    app,
    baseUrl: `http://127.0.0.1:${bound.port}`,
    onboarding,
    providerConnected,
  };
}

const readyScript: GithubScript = {
  installations: async (page) => ({
    items: page === 1 ? [installation(1)] : [],
    nextPage: null,
  }),
  repositories: async () => ({ items: [repository("acme/app")], nextPage: null }),
};

function get(baseUrl: string) {
  return fetch(`${baseUrl}/api/onboarding`, { headers: { origin }, redirect: "manual" });
}

async function getOnboarding(baseUrl: string) {
  return onboardingResponseSchema.parse(await (await get(baseUrl)).json());
}

async function errorCode(response: Response): Promise<string> {
  const body = z.object({ error: z.object({ code: z.string() }) }).parse(await response.json());

  return body.error.code;
}

function complete(baseUrl: string) {
  return fetch(`${baseUrl}/api/onboarding/complete`, {
    method: "POST",
    headers: { origin, "x-csrf-protection": "1", "content-type": "application/json" },
    body: "{}",
    redirect: "manual",
  });
}

describe("GET /api/onboarding", () => {
  test("reports unconfigured GitHub as a retryable state with the install URL", async () => {
    const { app, baseUrl } = await listen();
    const body = await getOnboarding(baseUrl);

    expect(body).toEqual({
      completed: false,
      github: {
        ready: false,
        installUrl: "https://github.com/apps/cloud-swe/installations/new",
        transientError: true,
        hasAnyInstallation: false,
      },
      providerReady: true,
    });
    await app.close();
  });

  test("reports ready when an installation has a readable repository", async () => {
    const { app, baseUrl } = await listen({ github: fakeGithub(readyScript) });
    const body = await getOnboarding(baseUrl);

    expect(body.github).toMatchObject({
      ready: true,
      transientError: false,
      hasAnyInstallation: true,
    });
    await app.close();
  });

  test("pages through installations to find an eligible one", async () => {
    const { app, baseUrl } = await listen({
      github: fakeGithub({
        installations: async (page) =>
          page === 1
            ? { items: [installation(1, { suspended: true })], nextPage: 2 }
            : { items: [installation(2)], nextPage: null },
        repositories: async (installationId) =>
          installationId === 2
            ? { items: [repository("org/only")], nextPage: null }
            : { items: [], nextPage: null },
      }),
    });

    const body = await getOnboarding(baseUrl);

    expect(body.github.ready).toBe(true);
    await app.close();
  });

  test("treats an installation from another App as ineligible", async () => {
    const { app, baseUrl } = await listen({
      github: fakeGithub({
        installations: async () => ({ items: [foreignInstallation], nextPage: null }),
        repositories: async () => ({ items: [repository("other/app")], nextPage: null }),
      }),
    });

    const body = await getOnboarding(baseUrl);

    expect(body.github).toMatchObject({ ready: false, transientError: false });
    await app.close();
  });

  test("reports retryable when installation pagination is incomplete", async () => {
    const { app, baseUrl, onboarding } = await listen({
      completed: true,
      github: fakeGithub({
        installations: async (page) => ({
          items: [],
          nextPage: page < 4 ? page + 1 : null,
        }),
        repositories: async () => ({ items: [], nextPage: null }),
      }),
    });

    const body = await getOnboarding(baseUrl);

    expect(body).toMatchObject({ completed: true, github: { transientError: true } });
    expect(onboarding.state.cleared).toBe(0);
    await app.close();
  });

  test("reports retryable when repository pagination is incomplete", async () => {
    const { app, baseUrl } = await listen({
      github: fakeGithub({
        installations: async () => ({ items: [installation(1)], nextPage: null }),
        repositories: async (page) => ({
          items: [],
          nextPage: page < 4 ? page + 1 : null,
        }),
      }),
    });

    const body = await getOnboarding(baseUrl);

    expect(body.github).toMatchObject({ ready: false, transientError: true });
    await app.close();
  });

  test("treats an installation with no readable repository as absent", async () => {
    const { app, baseUrl } = await listen({
      github: fakeGithub({
        installations: async () => ({ items: [installation(1)], nextPage: null }),
        repositories: async () => ({ items: [], nextPage: null }),
      }),
    });

    const body = await getOnboarding(baseUrl);

    expect(body.github).toMatchObject({ ready: false, transientError: false });
    await app.close();
  });

  test("clears completion on confirmed absence and routes to repair", async () => {
    const { app, baseUrl, onboarding } = await listen({
      completed: true,
      github: fakeGithub({
        installations: async () => ({ items: [], nextPage: null }),
        repositories: async () => ({ items: [], nextPage: null }),
      }),
    });

    const response = await get(baseUrl);
    const body = onboardingResponseSchema.parse(await response.json());

    expect(body.completed).toBe(false);
    expect(onboarding.state.cleared).toBe(1);
    // The cookie cache is refreshed so the browser sees the transition.
    expect(response.headers.getSetCookie().length).toBeGreaterThan(0);
    await app.close();
  });

  test("keeps completion on a transient upstream failure and offers retry", async () => {
    const { app, baseUrl, onboarding } = await listen({
      completed: true,
      github: fakeGithub({
        installations: async () => {
          throw new Error("upstream 502");
        },
        repositories: async () => ({ items: [], nextPage: null }),
      }),
    });

    const body = await getOnboarding(baseUrl);

    expect(body).toMatchObject({
      completed: true,
      github: { ready: false, transientError: true },
    });
    expect(onboarding.state.cleared).toBe(0);
    await app.close();
  });
});

describe("POST /api/onboarding/complete", () => {
  test("requires a confirmed installation with a readable repository", async () => {
    const { app, baseUrl, onboarding } = await listen({
      github: fakeGithub({
        installations: async () => ({ items: [], nextPage: null }),
        repositories: async () => ({ items: [], nextPage: null }),
      }),
    });

    const response = await complete(baseUrl);

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("GITHUB_REPOSITORY_REQUIRED");
    expect(onboarding.state.completedCalls).toBe(0);
    await app.close();
  });

  test("requires at least one stored provider credential", async () => {
    const { app, baseUrl, onboarding } = await listen({
      github: fakeGithub(readyScript),
      providerConnected: false,
    });

    const response = await complete(baseUrl);

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("PROVIDER_REQUIRED");
    expect(onboarding.state.completedCalls).toBe(0);
    await app.close();
  });

  test("returns a retryable error for a transient GitHub failure", async () => {
    const { app, baseUrl } = await listen({
      github: fakeGithub({
        installations: async () => {
          throw new Error("upstream 502");
        },
        repositories: async () => ({ items: [], nextPage: null }),
      }),
    });

    const response = await complete(baseUrl);

    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("GITHUB_UNAVAILABLE");
    await app.close();
  });

  test("is unavailable when GitHub is not configured", async () => {
    const { app, baseUrl } = await listen();
    const response = await complete(baseUrl);

    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("GITHUB_UNAVAILABLE");
    await app.close();
  });

  test("persists completion and forwards the refreshed session cookie", async () => {
    const { app, baseUrl, onboarding } = await listen({
      github: fakeGithub(readyScript),
      refreshCookies: ["better-auth.session_data=fresh; Path=/; HttpOnly"],
    });

    const response = await complete(baseUrl);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ completed: true });
    expect(response.headers.getSetCookie()).toEqual([
      "better-auth.session_data=fresh; Path=/; HttpOnly",
    ]);
    expect(onboarding.state.completedCalls).toBe(1);
    await app.close();
  });

  test("succeeds idempotently on a repeated eligible completion", async () => {
    const { app, baseUrl, onboarding } = await listen({
      github: fakeGithub(readyScript),
      completed: true,
    });

    expect((await complete(baseUrl)).status).toBe(200);
    expect((await complete(baseUrl)).status).toBe(200);
    expect(onboarding.state.completedCalls).toBe(2);
    await app.close();
  });
});

describe("GitHub readiness bounds and configuration", () => {
  test("a missing App slug is never treated as a confirmed absence", async () => {
    const harness = await listen({
      github: fakeGithub(readyScript),
      completed: true,
      appSlug: null,
    });

    const body = await getOnboarding(harness.baseUrl);

    expect(body.completed).toBe(true);
    expect(body.github.ready).toBe(false);
    expect(body.github.transientError).toBe(true);
    // Completion is durable until an absence is actually proven.
    expect(harness.onboarding.state.cleared).toBe(0);
    await harness.app.close();
  });

  test("a hung upstream call is bounded by the overall deadline", async () => {
    const github = fakeGithub({
      installations: () => new Promise(() => undefined),
      repositories: async () => ({ items: [], nextPage: null }),
    });

    const started = Date.now();
    const readiness = await verifyGithubReadiness(github, userId, "cloud-swe", 25);

    expect(readiness).toBe("transient");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
