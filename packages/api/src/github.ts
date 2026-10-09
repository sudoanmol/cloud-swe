import { jsonValueSchema, type JsonObject } from "@cloud-swe/db/json";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { imageSkills, skillMetadataSchema, type SkillMetadata } from "@cloud-swe/db/skills";
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
  size: z.number().int().nonnegative().optional(),
  permissions: z.object({ pull: z.boolean().optional(), push: z.boolean().optional() }).optional(),
});

export const githubBranchSchema = z.object({
  name: z.string(),
  protected: z.boolean(),
  commit: z.object({ sha: z.string(), url: z.string() }),
});

export const githubPrSchema = z.object({
  node_id: z.string().optional(),
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

/**
 * Installation listing uses GitHub's `GET /user/installations`. Identity and
 * suspension come from real API fields: `app_slug`/`app_id` prove which App
 * the installation belongs to, and `suspended_at` (non-null) is suspension.
 * Missing proof is never treated as eligible.
 */
export const githubInstallationSchema = z.object({
  id: z.number().int().positive(),
  account: z
    .object({
      login: z.string(),
      type: z.string().optional(),
    })
    .nullable()
    .optional(),
  app_id: z.number().int().positive(),
  app_slug: z.string().min(1),
  target_type: z.string().optional(),
  repository_selection: z.string().optional(),
  suspended_at: z.string().nullable().optional(),
});

export const githubInstallationsResponseSchema = z.object({
  total_count: z.number().int().nonnegative(),
  installations: z.array(githubInstallationSchema),
});

export function githubRepositoryPath(repositoryUrl: string): string {
  return new URL(githubUrlSchema.parse(repositoryUrl)).pathname.replace(/\.git$/, "");
}

const treeSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string(),
      type: z.enum(["blob", "tree", "commit"]),
      sha: z.string(),
      size: z.number().optional(),
    }),
  ),
});

const commitSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  commit: z.object({ tree: z.object({ sha: z.string() }) }),
});

const skillFrontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string(),
});

export function createGithubClient(
  loadToken: (userId: string) => Promise<string>,
  fetcher: typeof fetch = fetch,
) {
  // Coalesce refreshes without retaining tokens after the request settles.
  const refreshing = new Map<string, Promise<string>>();

  const trees = new Map<
    string,
    { sha: string; entries: z.infer<typeof treeSchema>["tree"]; truncated: boolean }
  >();

  const skillCatalogs = new Map<string, SkillMetadata[]>();

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
    options: { method?: string; body?: JsonObject; diff?: boolean; maxBytes?: number } = {},
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

    const text = await boundedResponse(response, options.maxBytes ?? 2_097_152);

    if (options.diff) return text;

    try {
      return jsonValueSchema.parse(JSON.parse(text || "null"));
    } catch {
      return gitError("GIT_UPSTREAM_FAILED", 502);
    }
  }

  async function repositoryTree(userId: string, url: string, ref: string | undefined) {
    const repository = githubRepositorySchema.parse(
      await request(userId, `/repos${githubRepositoryPath(url)}`),
    );

    if (repository.permissions?.pull !== true) return gitError("GIT_ACCESS_DENIED", 403);

    if (repository.size === 0) return { sha: null, entries: [], truncated: false };
    const base = `/repos${githubRepositoryPath(url)}`;

    const commit = commitSchema.parse(
      await request(
        userId,
        `${base}/commits/${encodeURIComponent(ref ?? repository.default_branch)}`,
      ),
    );

    const key = `${userId}:${repository.id}:${commit.sha}`;
    const cached = trees.get(key);

    if (cached) return cached;

    const recursive = treeSchema.parse(
      await request(userId, `${base}/git/trees/${commit.commit.tree.sha}?recursive=1`, {
        maxBytes: 8_388_608,
      }),
    );

    let entries = recursive.tree;
    let truncated = recursive.truncated;

    if (truncated) {
      entries = [];
      const pending = [{ sha: commit.commit.tree.sha, prefix: "" }];

      // ponytail: bound traversal to 256 tree reads/100k entries; show partial results beyond that.
      for (let reads = 0; pending.length && reads < 256 && entries.length < 100_000; reads++) {
        const next = pending.shift();

        if (!next) break;

        const tree = treeSchema.parse(
          await request(userId, `${base}/git/trees/${next.sha}`, { maxBytes: 8_388_608 }),
        );

        if (tree.truncated) {
          pending.push(next);
          break;
        }

        for (const entry of tree.tree) {
          if (entries.length >= 100_000) {
            pending.push(next);
            break;
          }

          const path = `${next.prefix}${entry.path}`;
          entries.push({ ...entry, path });

          if (entry.type === "tree") pending.push({ sha: entry.sha, prefix: `${path}/` });
        }
      }

      truncated = pending.length > 0;
    }

    const result = { sha: commit.sha, entries, truncated };

    if (trees.size >= 32) {
      const oldest = trees.keys().next().value;

      if (oldest) trees.delete(oldest);
    }

    trees.set(key, result);

    return result;
  }

  return {
    request,
    async graphql(userId: string, query: string, variables: JsonObject) {
      const response = z
        .object({ data: jsonValueSchema.optional(), errors: z.array(z.unknown()).optional() })
        .parse(
          await request(userId, "/graphql", {
            method: "POST",
            body: { query, variables: jsonValueSchema.parse(variables) },
          }),
        );

      if (response.errors?.length || !response.data) return gitError("GIT_UPSTREAM_FAILED", 502);

      return response.data;
    },
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
    /** Installations of this GitHub App that the signed-in user may access. */
    async installations(userId: string, page: number) {
      const parsed = githubInstallationsResponseSchema.parse(
        await request(userId, `/user/installations?per_page=50&page=${page}`),
      );

      const items = parsed.installations.map((installation) => ({
        id: installation.id,
        accountLogin: installation.account?.login ?? "unknown",
        accountType: installation.account?.type ?? "User",
        targetType: installation.target_type ?? "User",
        appId: installation.app_id,
        appSlug: installation.app_slug,
        repositorySelection: installation.repository_selection ?? "selected",
        /** Real suspension proof: `suspended_at` is null while active. */
        suspended: installation.suspended_at !== null && installation.suspended_at !== undefined,
      }));

      return { items, nextPage: items.length === 50 ? page + 1 : null };
    },
    /** Repositories readable through one installation of this App. */
    async installationRepositories(userId: string, installationId: number, page: number) {
      const parsed = z
        .object({
          total_count: z.number().int().nonnegative(),
          repositories: z.array(githubRepositorySchema),
        })
        .parse(
          await request(
            userId,
            `/user/installations/${installationId}/repositories?per_page=50&page=${page}`,
          ),
        );

      const items = parsed.repositories
        // Readiness and the product picker both need readable repositories;
        // an installation entry without proven pull access is not usable.
        .filter((repository) => repository.permissions?.pull === true)
        .map((repository) => ({
          id: repository.id,
          fullName: repository.full_name,
          owner: repository.full_name.split("/")[0] ?? repository.full_name,
          name: repository.name,
          private: repository.private,
          defaultBranch: repository.default_branch || null,
          /** Unborn/empty repositories report zero size; never invent a branch. */
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The validated GitHub payload omits `size` for some responses; absent is not zero.
          empty: typeof repository.size === "number" ? repository.size === 0 : null,
        }));

      return { items, nextPage: parsed.repositories.length === 50 ? page + 1 : null };
    },
    async tree(userId: string, url: string, ref?: string) {
      const tree = await repositoryTree(userId, url, ref);

      return {
        sha: tree.sha,
        paths: tree.entries.flatMap((entry) => (entry.type === "blob" ? [entry.path] : [])),
        truncated: tree.truncated,
      };
    },
    async skills(userId: string, url: string, ref?: string) {
      const tree = await repositoryTree(userId, url, ref);
      const key = `${userId}:${url}:${tree.sha}`;
      const cached = skillCatalogs.get(key);

      if (cached) return { skills: cached };
      const skills: SkillMetadata[] = [];
      let bytes = 0;

      const candidates = tree.entries
        .filter(
          (entry) =>
            entry.type === "blob" &&
            /^\.(pi|agents)\/skills\/(?:[^/]+\.md|.+\/SKILL\.md)$/.test(entry.path),
        )
        .sort(
          (a, b) =>
            Number(b.path.startsWith(".pi/")) - Number(a.path.startsWith(".pi/")) ||
            a.path.localeCompare(b.path),
        );

      for (const entry of candidates.slice(0, 200 - imageSkills.length)) {
        if ((entry.size ?? 0) > 65_536) continue;

        const blob = z
          .object({
            encoding: z.literal("base64"),
            content: z.string(),
            size: z.number().max(65_536),
          })
          .parse(
            await request(userId, `/repos${githubRepositoryPath(url)}/git/blobs/${entry.sha}`),
          );

        const decoded = Buffer.from(blob.content, "base64");

        if (decoded.byteLength > 65_536) continue;
        bytes += decoded.byteLength;

        if (bytes > 1_048_576) break;

        const content = decoded
          .toString("utf8")
          .replace(/^\uFEFF/, "")
          .replace(/\r\n?/g, "\n");

        const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content)?.[1];

        if (!frontmatter) continue;
        let parsed;

        try {
          parsed = skillFrontmatterSchema.safeParse(parseYaml(frontmatter));
        } catch {
          continue;
        }

        if (!parsed.success) continue;
        const name = parsed.data.name || entry.path.split("/").at(-2);

        const skill = skillMetadataSchema.safeParse({
          name,
          description: parsed.data.description,
          path: `/workspace/${entry.path}`,
        });

        if (skill.success && !skills.some((item) => item.name === skill.data.name))
          skills.push(skill.data);
      }

      for (const skill of imageSkills)
        if (!skills.some((item) => item.name === skill.name)) skills.push(skill);

      if (skillCatalogs.size >= 32) {
        const oldest = skillCatalogs.keys().next().value;

        if (oldest) skillCatalogs.delete(oldest);
      }

      skillCatalogs.set(key, skills);

      return { skills };
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
