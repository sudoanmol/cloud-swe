import { jsonValueSchema, type JsonObject } from "@cloud-swe/db/json";
import { z } from "zod";
import { gitError } from "@cloud-swe/db/git-store";
import { githubUrlSchema } from "@cloud-swe/db/git-contracts";

export const githubRepositorySchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
  default_branch: z.string(),
  html_url: z.url(),
  clone_url: z.url(),
  permissions: z.object({ pull: z.boolean().optional(), push: z.boolean().optional() }).optional(),
});

export const githubBranchSchema = z.object({
  name: z.string(),
  protected: z.boolean(),
  commit: z.object({ sha: z.string(), url: z.string() }),
});

export const githubPrSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.url(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  merged: z.boolean().optional(),
  draft: z.boolean().optional(),
  head: z.object({ sha: z.string(), ref: z.string() }),
  base: z.object({ ref: z.string(), repo: z.object({ id: z.number() }) }),
});

export const githubCommentSchema = z.object({
  id: z.number(),
  html_url: z.url(),
  body: z.string(),
  user: z.object({ id: z.number() }),
});

export function githubRepositoryPath(repositoryUrl: string): string {
  return new URL(githubUrlSchema.parse(repositoryUrl)).pathname.replace(/\.git$/, "");
}

export function createGithubClient(
  loadToken: (userId: string) => Promise<string>,
  fetcher: typeof fetch = fetch,
) {
  // Coalesce refreshes without retaining tokens after the request settles.
  const refreshing = new Map<string, Promise<string>>();

  function getToken(userId: string): Promise<string> {
    const current = refreshing.get(userId);

    if (current) return current;

    const next = Promise.resolve()
      .then(() => loadToken(userId))
      .finally(() => refreshing.delete(userId));

    refreshing.set(userId, next);

    return next;
  }

  async function request(
    userId: string,
    path: string,
    options: { method?: string; body?: JsonObject; diff?: boolean } = {},
  ) {
    if (!path.startsWith("/") || path.startsWith("//")) gitError("GIT_ACCESS_DENIED", 403);
    const token = await getToken(userId);
    let response: Response;

    try {
      response = await fetcher(`https://api.github.com${path}`, {
        method: options.method ?? "GET",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: options.diff ? "application/vnd.github.diff" : "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
    } catch {
      return gitError("GIT_UPSTREAM_FAILED", 502);
    }

    if (!response.ok) {
      await response.body?.cancel();

      if ([401, 403, 404].includes(response.status))
        return gitError("GIT_ACCESS_DENIED", response.status === 404 ? 404 : 403);

      if ([409, 422, 405].includes(response.status)) return gitError("GIT_PROPOSAL_STALE");

      return gitError("GIT_UPSTREAM_FAILED", 502);
    }

    const text = await boundedResponse(response, 2_097_152);

    if (options.diff) return text;

    try {
      return jsonValueSchema.parse(JSON.parse(text || "null"));
    } catch {
      return gitError("GIT_UPSTREAM_FAILED", 502);
    }
  }

  return {
    request,
    token: getToken,
    async transport(
      userId: string,
      url: string,
      suffix: "info/refs" | "git-upload-pack",
      body: Buffer | undefined,
      protocolV2: boolean,
    ) {
      githubUrlSchema.parse(url);
      const token = await getToken(userId);

      const headers = new Headers({
        Authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      });

      if (body) headers.set("Content-Type", "application/x-git-upload-pack-request");

      if (protocolV2) headers.set("Git-Protocol", "version=2");

      try {
        return await fetcher(
          `${url}/${suffix}${suffix === "info/refs" ? "?service=git-upload-pack" : ""}`,
          {
            method: body ? "POST" : "GET",
            body,
            redirect: "error",
            signal: AbortSignal.timeout(240_000),
            headers,
          },
        );
      } catch {
        return gitError("GIT_UPSTREAM_FAILED", 502);
      }
    },
    async repository(userId: string, url: string) {
      return githubRepositorySchema.parse(
        await request(userId, `/repos${githubRepositoryPath(url)}`),
      );
    },
    async repositories(userId: string, page: number) {
      const items = githubRepositorySchema
        .array()
        .parse(
          await request(
            userId,
            `/user/repos?per_page=50&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
          ),
        );

      return { items, nextPage: items.length === 50 ? page + 1 : null };
    },
    async branches(userId: string, url: string, page: number) {
      await this.repository(userId, url);

      const items = githubBranchSchema
        .array()
        .parse(
          await request(
            userId,
            `/repos${githubRepositoryPath(url)}/branches?per_page=50&page=${page}`,
          ),
        );

      return { items, nextPage: items.length === 50 ? page + 1 : null };
    },
  };
}

export async function boundedResponse(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  try {
    for (;;) {
      const chunk = await reader.read();

      if (chunk.done) break;
      bytes += chunk.value.byteLength;

      if (bytes > maxBytes) gitError("GIT_UPSTREAM_FAILED", 502);
      chunks.push(chunk.value);
    }

    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel();
  }
}

export type GithubClient = ReturnType<typeof createGithubClient>;
