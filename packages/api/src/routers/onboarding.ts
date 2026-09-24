import type { FastifyInstance } from "fastify";

import type { OnboardingStore } from "@cloud-swe/db/onboarding";
import type { SessionCookieRefresher } from "../http";
import type { GithubClient } from "../github";
import { sendError, sendFailure } from "../http";

/**
 * GitHub readiness for onboarding.
 *
 * `ready` and `absent` are confirmed server observations. `transient`
 * distinguishes an upstream or configuration failure from a durable
 * revocation, so the UI can offer Retry instead of routing to repair.
 * `unconfigured` means GitHub App OAuth is not configured at all.
 */
export type GithubReadiness = "ready" | "absent" | "transient" | "unconfigured";

/**
 * The narrow GitHub surface onboarding needs. Keeps readiness testable without
 * a full transport client.
 */
export type GithubReadinessClient = Pick<
  GithubClient,
  "installations" | "installationRepositories"
>;

/** Bound the readiness check so it cannot page or run forever. */
export const GITHUB_READINESS_MAX_PAGES = 3;

export const GITHUB_READINESS_TIMEOUT_MS = 20_000;

/** Raised when one pending readiness await outlives the overall deadline. */
class ReadinessDeadlineError extends Error {
  constructor() {
    super("GitHub readiness deadline exceeded");
    this.name = "ReadinessDeadlineError";
  }
}

/**
 * Bound one pending await against the readiness deadline.
 *
 * The overall budget must hold even when a token lookup or upstream call never
 * settles; the underlying request keeps its own provider timeout and is
 * discarded rather than awaited.
 */
function bounded<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ReadinessDeadlineError());

    if (signal.aborted) {
      onAbort();

      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
    work().then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Promise rejections carry arbitrary values; the reason passes through unchanged.
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Verify that this GitHub App has a non-suspended installation visible to the
 * signed-in user with at least one readable repository.
 *
 * A single repository denial is never treated as proof that all installations
 * disappeared: only a successful, complete enumeration with zero eligible
 * installations or zero readable repositories is `absent`. Missing App identity
 * configuration and an incomplete enumeration (page or elapsed budget
 * exhausted) are retryable, never proof of absence.
 */
export async function verifyGithubReadiness(
  github: GithubReadinessClient,
  userId: string,
  expectedAppSlug: string | undefined,
  /** Overridable only so tests can prove the deadline without waiting 20s. */
  timeoutMs = GITHUB_READINESS_TIMEOUT_MS,
): Promise<GithubReadiness> {
  // Without the App slug no installation can be proven to belong to this App.
  if (!expectedAppSlug) return "transient";

  const signal = AbortSignal.timeout(timeoutMs);

  try {
    for (let page = 1; page <= GITHUB_READINESS_MAX_PAGES; page++) {
      const installations = await bounded(() => github.installations(userId, page), signal);

      for (const installation of installations.items) {
        if (installation.suspended) continue;

        // Only this App's installations are eligible; missing identity proof
        // is never treated as eligible.
        if (installation.appSlug !== expectedAppSlug) continue;

        for (let repoPage = 1; repoPage <= GITHUB_READINESS_MAX_PAGES; repoPage++) {
          const repositories = await bounded(
            () => github.installationRepositories(userId, installation.id, repoPage),
            signal,
          );

          // The client only returns repositories with proven pull access.
          if (repositories.items.length > 0) return "ready";

          if (!repositories.nextPage) break;

          // Exhausting the page budget with more pages remaining is an
          // incomplete enumeration, not proof of absence.
          if (repoPage === GITHUB_READINESS_MAX_PAGES) return "transient";
        }
      }

      if (!installations.nextPage) return "absent";

      if (page === GITHUB_READINESS_MAX_PAGES) return "transient";
    }

    return "transient";
  } catch {
    // Upstream, configuration, or deadline failure: not proof of absence.
    return "transient";
  }
}

export type OnboardingRouteOptions = {
  store: OnboardingStore;
  /** Present only when GitHub App OAuth is configured. */
  github?: GithubReadinessClient;
  /** Server-only GitHub App slug used to build the install URL. */
  appSlug?: string;
  /** At least one saved model credential for the user. */
  providerReady: (userId: string) => Promise<boolean>;
  /**
   * Refreshes the signed session cookie cache through Better Auth's HTTP
   * handler so the response reaches the browser with fresh `Set-Cookie`.
   */
  refreshSession?: SessionCookieRefresher;
};

function installUrl(appSlug: string | undefined): string | null {
  return appSlug ? `https://github.com/apps/${appSlug}/installations/new` : null;
}

/** Registered inside the authenticated, CSRF-protected route scope. */
export function registerOnboardingRoutes(
  routes: FastifyInstance,
  options: OnboardingRouteOptions,
): void {
  routes.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");

    return payload;
  });

  routes.get("/api/onboarding", async (request, reply) => {
    const userId = request.threadUserId;

    if (!userId) return;

    try {
      const state = await options.store.readState(userId);

      const readiness: GithubReadiness = options.github
        ? await verifyGithubReadiness(options.github, userId, options.appSlug)
        : "unconfigured";

      const providerReady = await options.providerReady(userId);
      let completed = state.completed;

      // A confirmed absence clears durable completion and routes to repair. The
      // signed cookie cache is refreshed so the browser sees the transition.
      if (completed && readiness === "absent") {
        await options.store.clear(userId);
        completed = false;

        const cookies = (await options.refreshSession?.(request)) ?? [];

        if (cookies.length > 0) reply.header("set-cookie", cookies);
      }

      return reply.send({
        completed,
        github: {
          ready: readiness === "ready",
          installUrl: installUrl(options.appSlug),
          transientError: readiness === "transient" || readiness === "unconfigured",
          hasAnyInstallation: readiness === "ready",
        },
        providerReady,
      });
    } catch (error) {
      return sendFailure(request, reply, error);
    }
  });

  routes.post("/api/onboarding/complete", async (request, reply) => {
    const userId = request.threadUserId;

    if (!userId) return;

    try {
      if (!options.github)
        return sendError(
          reply,
          503,
          "GITHUB_UNAVAILABLE",
          "GitHub is not configured. Try again later.",
        );

      const readiness = await verifyGithubReadiness(options.github, userId, options.appSlug);

      if (readiness === "transient")
        return sendError(
          reply,
          503,
          "GITHUB_UNAVAILABLE",
          "GitHub is temporarily unavailable. Try again.",
        );

      if (readiness === "absent")
        return sendError(
          reply,
          409,
          "GITHUB_REPOSITORY_REQUIRED",
          "Install the GitHub App and grant at least one repository.",
        );

      if (!(await options.providerReady(userId)))
        return sendError(
          reply,
          409,
          "PROVIDER_REQUIRED",
          "Connect a model provider before finishing setup.",
        );

      // The store rechecks the provider condition inside the completion
      // transaction; the flag is never client-controlled.
      const result = await options.store.complete(userId);
      const cookies = (await options.refreshSession?.(request)) ?? [];

      if (cookies.length > 0) reply.header("set-cookie", cookies);

      return reply.send(result);
    } catch (error) {
      return sendFailure(request, reply, error);
    }
  });
}
