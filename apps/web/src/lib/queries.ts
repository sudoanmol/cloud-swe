import { infiniteQueryOptions, mutationOptions, queryOptions } from "@tanstack/react-query";
import { parseChecked, ThreadApiError } from "@cloud-swe/api/client";
import {
  reviewDiffSchema,
  reviewSummarySchema,
  workspaceFileSchema,
  workspacePathsSchema,
} from "@cloud-swe/db/workspace-review";
import {
  attachmentUploadResponseSchema,
  cancelResultSchema,
  deviceLoginStatusSchema,
  githubBranchesResponseSchema,
  githubInstallationsResponseSchema,
  githubRepositoriesResponseSchema,
  modelCatalogResponseSchema,
  modelProvidersResponseSchema,
  onboardingCompleteResponseSchema,
  onboardingResponseSchema,
  questionRequestSchema,
  questionsResponseSchema,
  submitResultSchema,
  threadListResponseSchema,
  threadSnapshotSchema,
} from "@cloud-swe/api/contracts";

import { api } from "./api";
import { emptyProjection, retainNewestSnapshot } from "./thread-projection";
import type { ThreadSnapshot } from "@cloud-swe/api/contracts";
import { submissionBody, type SubmissionEnvelope } from "./submission";

/**
 * Application REST reads and writes. Endpoint URLs and bodies live here, not
 * in a parallel chat store. Every key is scoped by the signed-in user so a late
 * response can never populate another account's cache.
 */
const scope = (userId: string) => ["session", userId] as const;

export function onboardingQueryOptions(userId: string) {
  return queryOptions({
    queryKey: [...scope(userId), "onboarding"],
    queryFn: ({ signal }) =>
      api
        .json("/api/onboarding", { signal })
        .then((body) => parseChecked(onboardingResponseSchema, body)),
  });
}

export function installationsQueryOptions(userId: string) {
  return infiniteQueryOptions({
    queryKey: [...scope(userId), "github", "installations"],
    queryFn: ({ signal, pageParam: page }) =>
      api
        .json(`/api/github/installations?page=${page}`, { signal })
        .then((body) => parseChecked(githubInstallationsResponseSchema, body)),
    initialPageParam: 1,
    getNextPageParam: (last) => last.nextPage ?? undefined,
  });
}

type RepositoryPageRequest = { installationId: number; page: number };

/**
 * The first page loads every installation's first page in parallel; later pages
 * continue one installation at a time.
 */
export function repositoriesQueryOptions(userId: string, installationIds: number[]) {
  return infiniteQueryOptions({
    queryKey: [...scope(userId), "github", "installation-repositories", installationIds],
    queryFn: async ({ signal, pageParam }) => {
      const pages = await Promise.all(
        pageParam.map(async (request) => {
          const body = await api.json(
            `/api/github/repositories?installationId=${request.installationId}&page=${request.page}`,
            { signal },
          );

          return { request, ...parseChecked(githubRepositoriesResponseSchema, body) };
        }),
      );

      return {
        items: pages.flatMap((page) => page.items),
        next: pages.flatMap(({ request, nextPage }): RepositoryPageRequest[] =>
          nextPage === null ? [] : [{ installationId: request.installationId, page: nextPage }],
        ),
      };
    },
    initialPageParam: installationIds.map((installationId): RepositoryPageRequest => ({
      installationId,
      page: 1,
    })),
    getNextPageParam: (_last, pages, _lastParam, params) => {
      const loaded = params.flat();

      const next = pages
        .flatMap((page) => page.next)
        .find(
          (candidate) =>
            !loaded.some(
              (request) =>
                request.installationId === candidate.installationId &&
                request.page === candidate.page,
            ),
        );

      return next ? [next] : undefined;
    },
  });
}

export function branchesQueryOptions(userId: string, owner: string, repo: string) {
  return infiniteQueryOptions({
    queryKey: [...scope(userId), "github", "branches", owner, repo],
    queryFn: ({ signal, pageParam: page }) =>
      api
        .json(
          `/api/github/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?page=${page}`,
          { signal },
        )
        .then((body) => parseChecked(githubBranchesResponseSchema, body)),
    initialPageParam: 1,
    getNextPageParam: (last) => last.nextPage ?? undefined,
  });
}

export function modelProvidersQueryOptions(userId: string) {
  return queryOptions({
    queryKey: [...scope(userId), "model-providers"],
    queryFn: ({ signal }) =>
      api
        .json("/api/model-providers", { signal })
        .then((body) => parseChecked(modelProvidersResponseSchema, body)),
  });
}

/** Device-login polling cadence while the backend is still minting the device code. */
const DEVICE_LOGIN_STARTING_INTERVAL_MS = 2_000;

export function deviceLoginQueryOptions(userId: string, loginId: string) {
  return queryOptions({
    queryKey: [...scope(userId), "device-login", loginId],
    queryFn: ({ signal }) =>
      api
        .json(`/api/model-providers/openai-codex/device-login/${loginId}`, { signal })
        .then((body) => parseChecked(deviceLoginStatusSchema, body)),
    // Keep polling through `starting` and `pending`, using the interval each
    // response asks for, and stop at a terminal state.
    refetchInterval: (query) => {
      const data = query.state.data;

      if (data?.status === "pending") return data.intervalSeconds * 1_000;

      return data?.status === "starting" ? DEVICE_LOGIN_STARTING_INTERVAL_MS : false;
    },
  });
}

export function completeOnboardingMutation() {
  return {
    mutationFn: () =>
      api
        .mutate("/api/onboarding/complete")
        .then((body) => parseChecked(onboardingCompleteResponseSchema, body)),
  };
}

export function saveProviderKeyMutation(mutationKey: readonly string[]) {
  return mutationOptions({
    mutationKey,
    onSettled: (_data, _error, variables, _result, context) => {
      const cache = context.client.getMutationCache();

      const mutation = cache.find({
        mutationKey,
        predicate: (item) => item.state.variables === variables,
      });

      if (mutation) cache.remove(mutation);
    },
    mutationFn: (input: { provider: string; apiKey: string }) =>
      api
        .mutate(`/api/model-providers/${encodeURIComponent(input.provider)}/credentials`, {
          body: JSON.stringify({ apiKey: input.apiKey }),
          method: "PUT",
        })
        .then(() => undefined),
  });
}

export function deleteProviderMutation() {
  return {
    mutationFn: (provider: string) =>
      api
        .mutate(`/api/model-providers/${encodeURIComponent(provider)}/credentials`, {
          method: "DELETE",
        })
        .then(() => undefined),
  };
}

export function startDeviceLoginMutation() {
  return {
    mutationFn: () =>
      api
        .mutate("/api/model-providers/openai-codex/device-login")
        .then((body) => parseChecked(deviceLoginStatusSchema, body)),
  };
}

const THREAD_PAGE_SIZE = 20;

/* oxlint-disable anti-slop/no-unknown-parameters -- React Query hands structural sharing untyped cache values. */
function sharedSnapshot(previous: unknown, incoming: unknown): ThreadSnapshot {
  const current = threadSnapshotSchema.safeParse(previous);

  return retainNewestSnapshot(
    current.success ? current.data : undefined,
    threadSnapshotSchema.parse(incoming),
  );
}

/** No cursor yet: the first history page. */
const FIRST_PAGE_CURSOR: string | null = null;

/** History pages by the server's opaque cursor, newest first, deduped by id. */
export function threadsQueryOptions(userId: string) {
  return infiniteQueryOptions({
    queryKey: [...scope(userId), "threads"],
    queryFn: ({ pageParam, signal }) =>
      api
        .json(
          `/api/threads?limit=${THREAD_PAGE_SIZE}${
            pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""
          }`,
          { signal },
        )
        .then((body) => parseChecked(threadListResponseSchema, body)),
    initialPageParam: FIRST_PAGE_CURSOR,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

export function threadProjectionQueryOptions(userId: string, threadId: string) {
  return queryOptions({
    queryKey: [...scope(userId), "projection", threadId],
    queryFn: () => emptyProjection(threadId),
    initialData: () => emptyProjection(threadId),
    enabled: false,
    staleTime: Infinity,
    // The reducer already shares unchanged parts; do not traverse every tool on each delta.
    structuralSharing: false,
  });
}

export function threadQueryOptions(userId: string, threadId: string) {
  return queryOptions({
    queryKey: [...scope(userId), "thread", threadId],
    queryFn: ({ signal }) =>
      api
        .json(`/api/threads/${threadId}`, { signal })
        .then((body) => parseChecked(threadSnapshotSchema, body)),
    // A slower read must not overwrite a newer snapshot already in the cache.
    structuralSharing: sharedSnapshot,
  });
}

export function questionsQueryOptions(userId: string, threadId: string) {
  return queryOptions({
    queryKey: [...scope(userId), "thread", threadId, "questions"],
    queryFn: ({ signal }) =>
      api
        .json(`/api/threads/${threadId}/questions`, { signal })
        .then((body) => parseChecked(questionsResponseSchema, body)),
  });
}

export function providerModelsQueryOptions(userId: string, provider: string) {
  return queryOptions({
    queryKey: [...scope(userId), "model-providers", provider, "models"],
    queryFn: ({ signal }) =>
      api
        .json(`/api/model-providers/${encodeURIComponent(provider)}/models`, { signal })
        .then((body) => parseChecked(modelCatalogResponseSchema, body)),
    staleTime: 5 * 60_000,
  });
}

export function submitEnvelopeMutation() {
  return {
    mutationFn: (envelope: SubmissionEnvelope) => {
      const request = submissionBody(envelope);

      return api
        .mutate(request.path, { body: JSON.stringify(request.body) })
        .then((body) => parseChecked(submitResultSchema, body));
    },
  };
}

export function cancelRunMutation() {
  return {
    mutationFn: (input: { threadId: string; runId: string }) =>
      api
        .mutate(`/api/threads/${input.threadId}/runs/${input.runId}/cancel`)
        .then((body) => parseChecked(cancelResultSchema, body)),
  };
}

export function answerQuestionMutation() {
  return {
    mutationFn: (input: { threadId: string; requestId: string; answers: Record<string, string> }) =>
      api
        .mutate(`/api/threads/${input.threadId}/questions/${input.requestId}/answer`, {
          body: JSON.stringify({ answers: input.answers }),
        })
        .then((body) => parseChecked(questionRequestSchema, body)),
  };
}

export function uploadAttachmentMutation() {
  return {
    mutationFn: (file: File) => {
      const body = new FormData();

      body.append("file", file);

      return api
        .mutate("/api/attachments", { body })
        .then((payload) => parseChecked(attachmentUploadResponseSchema, payload));
    },
  };
}

export function deleteAttachmentMutation() {
  return {
    mutationFn: (attachmentId: string) =>
      api.mutate(`/api/attachments/${attachmentId}`, { method: "DELETE" }).then(() => undefined),
  };
}

/** What the changes panel compares; every view diffs against the working tree except a commit. */
export type DiffView = { mode: "all" } | { mode: "uncommitted" } | { mode: "commit"; sha: string };

/** Review reads hit the live sandbox; a paused one answers 409 and is woken instead. */
export function workspaceQueryKey(userId: string, threadId: string) {
  return [...scope(userId), "thread", threadId, "workspace"] as const;
}

const reviewRetry = (failureCount: number, error: Error) =>
  error instanceof ThreadApiError && error.status === 503 && failureCount < 3;

export function workspaceSummaryQueryOptions(userId: string, threadId: string) {
  return queryOptions({
    queryKey: [...workspaceQueryKey(userId, threadId), "summary"],
    queryFn: ({ signal }) =>
      api
        .json(`/api/threads/${threadId}/workspace/summary`, { signal })
        .then((body) => parseChecked(reviewSummarySchema, body)),
    retry: reviewRetry,
  });
}

export function workspaceDiffQueryOptions(userId: string, threadId: string, view: DiffView) {
  const query = new URLSearchParams({ mode: view.mode });

  if (view.mode === "commit") query.set("commit", view.sha);

  return queryOptions({
    queryKey: [...workspaceQueryKey(userId, threadId), "diff", view],
    queryFn: ({ signal }) =>
      api
        .json(`/api/threads/${threadId}/workspace/diff?${query}`, { signal })
        .then((body) => parseChecked(reviewDiffSchema, body)),
    retry: reviewRetry,
    placeholderData: (previous) => previous,
  });
}

export function workspaceFilesQueryOptions(userId: string, threadId: string) {
  return queryOptions({
    queryKey: [...workspaceQueryKey(userId, threadId), "files"],
    queryFn: ({ signal }) =>
      api
        .json(`/api/threads/${threadId}/workspace/files`, { signal })
        .then((body) => parseChecked(workspacePathsSchema, body)),
    retry: reviewRetry,
    placeholderData: (previous) => previous,
  });
}

export function workspaceFileQueryOptions(userId: string, threadId: string, path: string) {
  return queryOptions({
    queryKey: [...workspaceQueryKey(userId, threadId), "file", path],
    queryFn: ({ signal }) =>
      api
        .json(`/api/threads/${threadId}/workspace/file?${new URLSearchParams({ path })}`, {
          signal,
        })
        .then((body) => parseChecked(workspaceFileSchema, body)),
    retry: reviewRetry,
  });
}

export function wakeWorkspaceMutation() {
  return {
    mutationFn: (threadId: string) =>
      api.mutate(`/api/threads/${threadId}/workspace/wake`).then(() => undefined),
  };
}
