import {
  manualGitFallback,
  manualGitPreviewSchema,
  manualGitRequestSchema,
  manualGitTextSchema,
  type ManualGitPreview,
} from "@cloud-swe/db/manual-git";
import type { ThreadStore } from "@cloud-swe/db/thread-contracts";
import { proposalDigest } from "@cloud-swe/db/git-digest";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  threadPrSchema,
  gitContextSchema,
  gitProposalSchema,
  gitReadSchema,
  gitRequestSchema,
  gitShaSchema,
  type GitContext,
  type GitProposal,
  type GitRequest,
} from "@cloud-swe/db/git-contracts";
import { gitError, type GitStore } from "@cloud-swe/db/git-store";
import { normalizeGitHubUrl } from "@cloud-swe/db/repository-url";
import { publicFailure } from "@cloud-swe/db/public-failure";
import { createContext, type AuthProvider } from "../context";
import { checkMutationSecurity } from "../security";
import { sendFailure } from "../http";
import {
  githubCommentSchema,
  githubPrSchema,
  githubRepositoryPath,
  type GithubClient,
} from "../github";
import { imageSkills } from "@cloud-swe/db/skills";
import type { createGitBundles } from "../git-bundles";

const capabilitySchema = z
  .object({
    kind: z.enum(["read", "upload"]),
    context: gitContextSchema,
    operationId: z.uuid().optional(),
    expires: z.number().int(),
  })
  .strict();

type Capability = z.infer<typeof capabilitySchema>;

export type GitBrokerOptions = {
  store: GitStore;
  github: GithubClient;
  bundles: ReturnType<typeof createGitBundles>;
  auth: AuthProvider;
  trustedOrigins: readonly string[];
  secret: string;
  publicUrl: string;
  maxBytes: number;
  threads?: ThreadStore;
  runLimit?: number;
  generateGitText?: (
    input: ManualGitPreview & { title: string },
  ) => Promise<z.infer<typeof manualGitTextSchema>>;
};

export function signGitCapability(secret: string, capability: Capability): string {
  const payload = Buffer.from(JSON.stringify(capabilitySchema.parse(capability))).toString(
    "base64url",
  );

  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

export function readGitCapability(secret: string, token: string): Capability {
  const [payload, signature, extra] = token.split(".");

  if (!payload || !signature || extra) return gitError("GIT_ACCESS_DENIED", 403);
  const expected = createHmac("sha256", secret).update(payload).digest();
  const supplied = Buffer.from(signature, "base64url");

  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    return gitError("GIT_ACCESS_DENIED", 403);

  try {
    const cap = capabilitySchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString()));

    if (cap.expires <= Date.now()) return gitError("GIT_ACCESS_DENIED", 403);

    return cap;
  } catch {
    return gitError("GIT_ACCESS_DENIED", 403);
  }
}

function authorization(request: FastifyRequest) {
  const value = request.headers.authorization;

  if (!value?.startsWith("Bearer ")) return gitError("GIT_ACCESS_DENIED", 403);

  return value.slice(7);
}

export function registerGitBroker(app: FastifyInstance, options: GitBrokerOptions) {
  const { store, github, bundles, secret } = options;

  async function userId(request: FastifyRequest) {
    const context = await createContext(options.auth, request.headers);

    if (!context.session) return gitError("GIT_ACCESS_DENIED", 401);

    return context.session.user.id;
  }

  async function checkedContext(context: GitContext) {
    const value = await store.context(context);

    if (!value.repositoryUrl) return gitError("GIT_ACCESS_DENIED", 403);
    const repository = await github.repository(value.current.userId, value.repositoryUrl);

    return { ...value, repositoryUrl: value.repositoryUrl, repository };
  }

  async function pr(user: string, url: string, number: number) {
    return githubPrSchema.parse(
      await github.request(user, `/repos${githubRepositoryPath(url)}/pulls/${number}`),
    );
  }

  async function branchHead(user: string, url: string, branch: string) {
    return z
      .object({ object: z.object({ sha: gitShaSchema }) })
      .parse(
        await github.request(
          user,
          `/repos${githubRepositoryPath(url)}/git/ref/heads/${encodeURIComponent(branch)}`,
        ),
      ).object.sha;
  }

  async function reviewThread(user: string, url: string, threadId: string) {
    const result = z
      .object({
        node: z.object({
          id: z.string(),
          isResolved: z.boolean(),
          pullRequest: z.object({
            number: z.number().int().positive(),
            repository: z.object({ url: z.string() }),
          }),
        }),
      })
      .parse(
        await github.graphql(
          user,
          "query($id: ID!) { node(id: $id) { ... on PullRequestReviewThread { id isResolved pullRequest { number repository { url } } } } }",
          { id: threadId },
        ),
      );

    if (normalizeGitHubUrl(result.node.pullRequest.repository.url) !== url)
      return gitError("GIT_ACCESS_DENIED", 403);

    return result.node;
  }

  async function prepare(
    context: GitContext,
    rawRequest: GitRequest,
    toolCallId: string,
    push?: { id: string; commit: string },
  ): Promise<GitProposal> {
    const request = gitRequestSchema.parse(rawRequest);
    const value = await checkedContext(context);
    const id = push?.id ?? randomUUID();

    const proposal = {
      id,
      toolCallId,
      repositoryUrl: value.repositoryUrl,
      repositoryId: value.repository.id,
      request,
      expectedHead: null,
      base: null,
      commit: null,
      bundleHash: null,
      preview: "",
    } satisfies Omit<GitProposal, "digest">;

    let details: Pick<
      GitProposal,
      "expectedHead" | "base" | "commit" | "bundleHash" | "preview" | "impact" | "pullRequest"
    > = proposal;

    if (request.kind === "push") {
      if (!push) return gitError("GIT_BUNDLE_INVALID");

      if (request.force && request.branch === value.repository.default_branch)
        return gitError("GIT_PROPOSAL_STALE");

      const prepared = await bundles.prepare(
        id,
        push.commit,
        value.repositoryUrl,
        request.branch,
        await github.token(value.current.userId),
        value.owner.repositoryBranch ?? value.repository.default_branch,
      );

      if (!request.force && prepared.impact.nonFastForward) return gitError("GIT_NON_FAST_FORWARD");
      details = {
        ...proposal,
        expectedHead: prepared.expectedHead,
        bundleHash: prepared.bundleHash,
        preview: prepared.preview,
        impact: { push: prepared.impact },
        commit: push.commit,
      };
    } else if (request.kind === "pr_create") {
      const marked = { ...request, body: `${request.body}\n\n<!-- cloud-swe-operation:${id} -->` };
      proposal.request = marked;

      const expectedHead = await branchHead(
        value.current.userId,
        value.repositoryUrl,
        request.head,
      );

      await branchHead(value.current.userId, value.repositoryUrl, request.base);

      // Best effort: without a merge preview the card shows only the branches, never "no conflicts".
      const pr = await bundles
        .prImpact(
          id,
          value.repositoryUrl,
          request.head,
          null,
          request.base,
          await github.token(value.current.userId),
        )
        .catch(() => undefined)
        .finally(() => bundles.remove(id));

      details = {
        ...proposal,
        expectedHead,
        base: request.base,
        preview: JSON.stringify({ request: marked, expectedHead }),
        ...(pr && { impact: { pr } }),
      };
    } else {
      const number =
        request.kind === "pr_review_resolve"
          ? (await reviewThread(value.current.userId, value.repositoryUrl, request.threadId))
              .pullRequest.number
          : request.number;

      const current = await pr(value.current.userId, value.repositoryUrl, number);

      if (request.kind === "pr_review_reply") {
        const comment = z
          .object({ pull_request_url: z.string() })
          .parse(
            await github.request(
              value.current.userId,
              `/repos${githubRepositoryPath(value.repositoryUrl)}/pulls/comments/${request.commentId}`,
            ),
          );

        if (
          comment.pull_request_url !==
          `https://api.github.com/repos${githubRepositoryPath(value.repositoryUrl)}/pulls/${number}`
        )
          return gitError("GIT_PROPOSAL_STALE");
      }

      if (current.base.repo.id !== value.repository.id) return gitError("GIT_PROPOSAL_STALE");

      if (request.kind === "pr_comment" || request.kind === "pr_review_reply")
        proposal.request = {
          ...request,
          body: `${request.body}\n\n<!-- cloud-swe-operation:${id} -->`,
        };
      details = {
        ...proposal,
        pullRequest: {
          number: current.number,
          title: current.title,
          body: current.body,
          head: current.head.ref,
          base: current.base.ref,
        },
        expectedHead: gitShaSchema.parse(current.head.sha),
        base: current.base.ref,
        preview: JSON.stringify({
          request: proposal.request,
          pullRequest: { number: current.number, title: current.title, url: current.html_url },
        }),
      };
    }

    const completed = {
      ...proposal,
      expectedHead: details.expectedHead,
      base: details.base,
      commit: details.commit,
      bundleHash: details.bundleHash,
      preview: details.preview,
      impact: details.impact,
      pullRequest: details.pullRequest,
    };

    return gitProposalSchema.parse({ ...completed, digest: proposalDigest(completed) });
  }

  async function execute(id: string, context?: GitContext) {
    const existing = await store.read(id);

    if (context) {
      await store.expire(context.runId);
      const owned = await store.context(context);

      if (
        existing.runId !== context.runId ||
        existing.userId !== owned.current.userId ||
        existing.proposal.repositoryUrl !== owned.repositoryUrl
      )
        return gitError("GIT_PROPOSAL_STALE");
    } else if (!["executing", "unknown"].includes(existing.execution)) {
      // Backend recovery can inspect dispatched writes, but never start a write.
      return existing;
    }

    if (
      existing.execution === "succeeded" ||
      existing.execution === "failed" ||
      existing.approval !== "approved"
    )
      return existing;

    try {
      const repository = await github.repository(existing.userId, existing.proposal.repositoryUrl);

      if (repository.id !== existing.proposal.repositoryId) return gitError("GIT_PROPOSAL_STALE");
      const r = existing.proposal.request;

      if (
        existing.execution === "not_started" &&
        r.kind === "push" &&
        r.force &&
        r.branch === repository.default_branch
      )
        return gitError("GIT_PROPOSAL_STALE");
    } catch (error) {
      const failure = publicFailure(error);

      if (
        existing.execution === "not_started" &&
        ["GIT_ACCESS_DENIED", "GIT_PROPOSAL_STALE"].includes(failure.code)
      )
        return store.finish(id, "failed", { code: failure.code }, "not_started");
      throw error;
    }

    const { operation, dispatch } = context
      ? await store.claim(id, context)
      : { operation: existing, dispatch: false };

    const p = operation.proposal;
    const r = p.request;
    const path = `/repos${githubRepositoryPath(p.repositoryUrl)}`;
    const user = existing.userId;

    try {
      if (r.kind === "push") {
        if (dispatch) await bundles.push(p, await github.token(user));

        const refs = z
          .object({ object: z.object({ sha: gitShaSchema }) })
          .parse(
            await github.request(user, `${path}/git/ref/heads/${encodeURIComponent(r.branch)}`),
          );

        if (refs.object.sha === p.commit)
          return await store.finish(id, "succeeded", { commit: p.commit, branch: r.branch });
      } else if (
        r.kind === "pr_create" ||
        r.kind === "pr_comment" ||
        r.kind === "pr_review_reply"
      ) {
        if (dispatch) {
          if (
            r.kind === "pr_create" &&
            (await branchHead(user, p.repositoryUrl, r.head)) !== p.expectedHead
          )
            return await store.finish(id, "failed", { code: "GIT_PROPOSAL_STALE" });

          const result =
            r.kind === "pr_create"
              ? githubPrSchema.parse(
                  await github.request(user, `${path}/pulls`, {
                    method: "POST",
                    body: {
                      title: r.title,
                      body: r.body,
                      head: r.head,
                      base: r.base,
                      draft: r.draft,
                    },
                  }),
                )
              : githubCommentSchema.parse(
                  await github.request(
                    user,
                    r.kind === "pr_review_reply"
                      ? `${path}/pulls/${r.number}/comments/${r.commentId}/replies`
                      : `${path}/issues/${r.number}/comments`,
                    {
                      method: "POST",
                      body: { body: r.body },
                    },
                  ),
                );

          return await store.finish(id, "succeeded", { url: result.html_url });
        }

        // A missing marker does not establish that a dispatched write never happened.
        for (let page = 1; page <= 10; page++) {
          const results =
            r.kind === "pr_create"
              ? githubPrSchema
                  .array()
                  .parse(
                    await github.request(
                      user,
                      `${path}/pulls?state=all&sort=created&direction=desc&per_page=100&page=${page}`,
                    ),
                  )
              : githubCommentSchema
                  .array()
                  .parse(
                    await github.request(
                      user,
                      r.kind === "pr_review_reply"
                        ? `${path}/pulls/${r.number}/comments?per_page=100&page=${page}`
                        : `${path}/issues/${r.number}/comments?per_page=100&page=${page}`,
                    ),
                  );

          const found = results.find(
            (item) =>
              item.body === r.body && item.body.includes(`<!-- cloud-swe-operation:${id} -->`),
          );

          if (found) return await store.finish(id, "succeeded", { url: found.html_url });

          if (results.length < 100) break;
        }
      } else if (r.kind === "pr_review_resolve") {
        let current = await reviewThread(user, p.repositoryUrl, r.threadId);

        if (dispatch) {
          const pull = await pr(user, p.repositoryUrl, current.pullRequest.number);

          if (pull.head.sha !== p.expectedHead || pull.base.ref !== p.base)
            return await store.finish(id, "failed", { code: "GIT_PROPOSAL_STALE" });
          await github.graphql(
            user,
            "mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }",
            { id: r.threadId },
          );
          current = await reviewThread(user, p.repositoryUrl, r.threadId);
        }

        if (current.isResolved)
          return await store.finish(id, "succeeded", { number: current.pullRequest.number });
      } else {
        let current = await pr(user, p.repositoryUrl, r.number);

        if (dispatch) {
          if (current.head.sha !== p.expectedHead || current.base.ref !== p.base) {
            return await store.finish(id, "failed", { code: "GIT_PROPOSAL_STALE" });
          }

          if (r.kind === "pr_merge") {
            const merged = z.object({ merged: z.boolean(), sha: z.string() }).parse(
              await github.request(user, `${path}/pulls/${r.number}/merge`, {
                method: "PUT",
                body: { sha: p.expectedHead, merge_method: r.method },
              }),
            );

            if (merged.merged)
              return await store.finish(id, "succeeded", {
                url: current.html_url,
                commit: merged.sha,
              });
          } else if (r.kind === "pr_ready") {
            await github.graphql(
              user,
              "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { id isDraft } } }",
              { id: z.string().parse(current.node_id) },
            );
            current = await pr(user, p.repositoryUrl, r.number);
          } else {
            current = githubPrSchema.parse(
              await github.request(user, `${path}/pulls/${r.number}`, {
                method: "PATCH",
                body:
                  r.kind === "pr_update"
                    ? { title: r.title, body: r.body }
                    : { state: r.kind === "pr_close" ? "closed" : "open" },
              }),
            );
          }
        }

        let matches: boolean | undefined;

        switch (r.kind) {
          case "pr_merge":
            matches = current.merged && current.head.sha === p.expectedHead;
            break;
          case "pr_close":
            matches = current.state === "closed" && !current.merged;
            break;
          case "pr_reopen":
            matches = current.state === "open";
            break;
          case "pr_ready":
            matches = current.draft === false;
            break;
          case "pr_update":
            matches =
              (r.title === undefined || current.title === r.title) &&
              (r.body === undefined || current.body === r.body);
            break;
        }

        if (matches) return await store.finish(id, "succeeded", { url: current.html_url });
      }

      return await store.finish(id, "unknown", { code: "GIT_OPERATION_UNKNOWN" });
    } catch (error) {
      const failure = publicFailure(error);

      // Only a confirmed precondition/validation rejection can settle a dispatched write as failed.
      return store.finish(
        id,
        dispatch &&
          ["GIT_PROPOSAL_STALE", "GIT_NON_FAST_FORWARD", "GIT_BUNDLE_INVALID"].includes(
            failure.code,
          )
          ? "failed"
          : "unknown",
        { code: failure.code },
      );
    }
  }

  app.register(async (routes) => {
    let cleaning = false;

    const clean = async () => {
      if (cleaning) return;
      cleaning = true;

      try {
        for (const operation of await store.unsettled()) {
          try {
            await execute(operation.id);
          } catch {
            routes.log.warn({ code: "GIT_RECONCILIATION_FAILED" }, "Git recovery will retry");
          }
        }

        for (const { id, expired } of await bundles.cleanupCandidates()) {
          const operation = await store.read(id).catch((error) => {
            if (publicFailure(error).code === "GIT_OPERATION_NOT_FOUND") return null;
            throw error;
          });

          if (operation) {
            await store.expire(operation.runId);

            if (["executing", "unknown"].includes(operation.execution)) continue;
          }

          if (
            expired ||
            (operation &&
              (operation.execution === "succeeded" ||
                operation.execution === "failed" ||
                ["rejected", "expired", "invalidated"].includes(operation.approval)))
          )
            await bundles.remove(id);
        }
      } catch {
        routes.log.warn({ code: "GIT_CLEANUP_FAILED" }, "Git staging cleanup will retry");
      } finally {
        cleaning = false;
      }
    };

    const cleanup = setInterval(() => void clean(), 60_000);
    cleanup.unref();
    routes.addHook("onClose", async () => clearInterval(cleanup));
    routes.setErrorHandler((error, request, reply) => {
      if (error instanceof z.ZodError)
        return reply
          .code(400)
          .send({ error: { code: "INVALID_REQUEST", message: "Invalid Git request" } });

      return sendFailure(request, reply, error);
    });

    if (options.threads) {
      const threads = options.threads;
      routes.get("/api/threads/:id/manual-git", async (request) => {
        const { id } = z.object({ id: z.uuid() }).parse(request.params);

        return store.manualAvailable(await userId(request), id);
      });
      routes.post("/api/threads/:id/manual-git", async (request, reply) => {
        if (
          checkMutationSecurity(request, {
            trustedOrigins: options.trustedOrigins,
            requireCsrfHeader: true,
            requireJsonBody: true,
          })
        )
          return gitError("GIT_ACCESS_DENIED", 403);
        const user = await userId(request);
        const { id } = z.object({ id: z.uuid() }).parse(request.params);

        const body = z
          .object({ clientMessageId: z.uuid(), request: manualGitRequestSchema })
          .strict()
          .parse(request.body);

        const owner = await store.manualAvailable(user, id);

        if (!owner.repositoryUrl) return gitError("GIT_ACCESS_DENIED", 403);
        const repository = await github.repository(user, owner.repositoryUrl);

        if (body.request.kind === "preview") body.request.base = repository.default_branch;
        else {
          const previewRun = await threads.loadRun(body.request.previewRunId);

          if (
            previewRun?.userId !== user ||
            previewRun.threadId !== id ||
            previewRun.status !== "completed"
          )
            return gitError("GIT_PROPOSAL_STALE");
          manualGitPreviewSchema.parse(
            (await threads.loadCheckpoint({ runId: previewRun.id, key: "manual-git-preview" }))
              ?.content,
          );
        }

        const result = await threads.submitMessage({
          userId: user,
          threadId: id,
          clientMessageId: body.clientMessageId,
          prompt: {
            preview: "Prepare Git changes for review",
            push: "Propose pushing this branch",
            pr_create: "Propose opening a pull request",
          }[body.request.kind],
          manualGit: body.request,
          maxActiveRuns: options.runLimit,
        });

        return reply.code(202).send(result);
      });
      routes.post("/api/threads/:id/manual-git/:runId/text", async (request) => {
        if (
          checkMutationSecurity(request, {
            trustedOrigins: options.trustedOrigins,
            requireCsrfHeader: true,
            requireJsonBody: true,
          })
        )
          return gitError("GIT_ACCESS_DENIED", 403);
        const user = await userId(request);
        const { id, runId } = z.object({ id: z.uuid(), runId: z.uuid() }).parse(request.params);
        const owner = await store.manualAvailable(user, id);
        const run = await threads.loadRun(runId);

        if (run?.userId !== user || run.threadId !== id) return gitError("GIT_ACCESS_DENIED", 403);
        const saved = await threads.loadCheckpoint({ runId, key: "manual-git-preview" });

        if (!saved || run.status !== "completed")
          return { status: run.status, preview: null, text: null };
        const preview = manualGitPreviewSchema.parse(saved.content);
        const fallback = manualGitFallback(preview);

        const text = options.generateGitText
          ? await options
              .generateGitText({ ...preview, title: owner.title ?? "" })
              .catch(() => fallback)
          : fallback;

        return { status: run.status, preview, text: manualGitTextSchema.parse(text) };
      });
    }

    routes.post("/api/threads/:id/git-operations/:operationId/decision", async (request) => {
      const security = checkMutationSecurity(request, {
        trustedOrigins: options.trustedOrigins,
        requireCsrfHeader: true,
        requireJsonBody: true,
      });

      if (security) return gitError("GIT_ACCESS_DENIED", 403);
      const params = z.object({ id: z.uuid(), operationId: z.uuid() }).parse(request.params);

      const body = z
        .object({
          decision: z.enum(["approve", "reject"]),
          digest: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(request.body);

      return store.decision({
        userId: await userId(request),
        threadId: params.id,
        id: params.operationId,
        ...body,
      });
    });

    routes.register(async (internal) => {
      internal.addHook("onRequest", async (request) => {
        const supplied = Buffer.from(authorization(request));
        const expected = Buffer.from(secret);

        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
          gitError("GIT_ACCESS_DENIED", 403);
      });
      internal.post("/internal/git/access", async (request) => {
        const context = gitContextSchema.parse(request.body);
        const value = await checkedContext(context);
        const expires = Date.now() + 900_000;

        return {
          repositoryUrl: value.repositoryUrl,
          url: `${options.publicUrl}/git/read`,
          token: signGitCapability(secret, { kind: "read", context, expires }),
          expires,
        };
      });
      internal.post("/internal/git/upload", async (request) => {
        const context = gitContextSchema.parse(request.body);
        await checkedContext(context);
        const id = randomUUID();

        return {
          id,
          url: `${options.publicUrl}/git/upload`,
          token: signGitCapability(secret, {
            kind: "upload",
            context,
            operationId: id,
            expires: Date.now() + 300_000,
          }),
        };
      });
      internal.post("/internal/git/prepare", async (request) => {
        const body = z
          .object({
            context: gitContextSchema,
            request: gitRequestSchema,
            toolCallId: z.string().min(1).max(255),
            push: z.object({ id: z.uuid(), commit: gitShaSchema }).optional(),
          })
          .strict()
          .parse(request.body);

        return prepare(body.context, body.request, body.toolCallId, body.push);
      });
      internal.post("/internal/git/execute", async (request) => {
        const body = z
          .object({ context: gitContextSchema.optional(), id: z.uuid() })
          .strict()
          .parse(request.body);

        return execute(body.id, body.context);
      });
      internal.post("/internal/git/read", async (request) => {
        const body = z
          .object({ context: gitContextSchema, read: gitReadSchema })
          .strict()
          .parse(request.body);

        const value = await checkedContext(body.context);
        const path = `/repos${githubRepositoryPath(value.repositoryUrl)}`;
        const r = body.read;

        if (r.action === "list")
          return githubPrSchema
            .array()
            .parse(
              await github.request(
                value.current.userId,
                `${path}/pulls?per_page=50&page=${r.page}`,
              ),
            );
        const current = await pr(value.current.userId, value.repositoryUrl, r.number ?? 0);

        if (r.action === "view") return current;

        if (r.action === "review_threads") {
          const [owner, name] = githubRepositoryPath(value.repositoryUrl).slice(1).split("/");

          return github.graphql(
            value.current.userId,
            "query($owner: String!, $name: String!, $number: Int!, $cursor: String) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 50, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { id path line originalLine isResolved comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { id databaseId body url author { login } } } } } } } }",
            { owner, name, number: current.number, cursor: r.cursor ?? null },
          );
        }

        if (r.action === "comments")
          return githubCommentSchema
            .array()
            .parse(
              await github.request(
                value.current.userId,
                `${path}/issues/${current.number}/comments?per_page=50&page=${r.page}`,
              ),
            );

        if (r.action === "diff")
          return github.request(value.current.userId, `${path}/pulls/${current.number}`, {
            diff: true,
          });

        return github.request(
          value.current.userId,
          `${path}/commits/${gitShaSchema.parse(current.head.sha)}/check-runs?per_page=50&page=${r.page}`,
        );
      });
    });

    routes.register(async (transport) => {
      transport.addContentTypeParser(
        "application/x-git-upload-pack-request",
        (_request, payload, done) => done(null, payload),
      );
      transport.addContentTypeParser("application/octet-stream", (_request, payload, done) =>
        done(null, payload),
      );
      transport.post("/git/upload", async (request) => {
        const cap = readGitCapability(secret, authorization(request));

        if (cap.kind !== "upload" || !cap.operationId) return gitError("GIT_ACCESS_DENIED", 403);
        await checkedContext(cap.context);

        return bundles.upload(cap.operationId, request.raw);
      });
      transport.route({
        method: ["GET", "POST"],
        url: "/git/read/*",
        handler: async (request, reply) => {
          const cap = readGitCapability(secret, authorization(request));

          if (cap.kind !== "read") return gitError("GIT_ACCESS_DENIED", 403);

          const suffix = z
            .object({ "*": z.enum(["info/refs", "git-upload-pack"]) })
            .parse(request.params)["*"];

          const query = z
            .object({ service: z.literal("git-upload-pack").optional() })
            .strict()
            .parse(request.query);

          if (
            (suffix === "info/refs" &&
              (request.method !== "GET" || query.service !== "git-upload-pack")) ||
            (suffix === "git-upload-pack" &&
              (request.method !== "POST" || query.service !== undefined))
          )
            return gitError("GIT_ACCESS_DENIED", 403);
          const value = await checkedContext(cap.context);
          // Buffer the bounded upload-pack negotiation only; pack responses stream with backpressure.
          let body: Buffer | undefined;

          if (request.method === "POST") {
            const chunks: Buffer[] = [];
            let bytes = 0;

            const timeout = setTimeout(() => request.raw.destroy(), 30_000);

            try {
              for await (const chunk of request.raw) {
                bytes += chunk.length;

                if (bytes > 1_048_576) return gitError("GIT_ACCESS_DENIED", 413);
                chunks.push(chunk);
              }
            } finally {
              clearTimeout(timeout);
            }

            body = Buffer.concat(chunks);
          }

          const upstream = await github.transport(
            value.current.userId,
            value.repositoryUrl,
            suffix,
            body,
            request.headers["git-protocol"] === "version=2",
          );

          if (!upstream.ok || !upstream.body) {
            await upstream.body?.cancel();

            return gitError("GIT_ACCESS_DENIED", 403);
          }

          let bytes = 0;

          const limiter = new Transform({
            transform(chunk: Buffer, _encoding, next) {
              bytes += chunk.length;

              if (bytes > options.maxBytes) next(new Error("Git response exceeds limit"));
              else next(null, chunk);
            },
          });

          const stream = Readable.from(upstream.body);
          stream.on("error", () => limiter.destroy(new Error("Git transport failed")));
          limiter.on("close", () => stream.destroy());
          reply
            .header("Cache-Control", "no-store")
            .type(
              suffix === "info/refs"
                ? "application/x-git-upload-pack-advertisement"
                : "application/x-git-upload-pack-result",
            );

          return reply.send(stream.pipe(limiter));
        },
      });
    });
  });
}

/**
 * GitHub metadata and read routes.
 *
 * Extracted from the broker so registration depends only on a GitHub client,
 * a Git store, and sessions. Repository selection and onboarding work while
 * the broker tunnel, bundle storage, and capability transport are deferred.
 */
export type GithubReadOptions = {
  github: GithubClient;
  store: Pick<GitStore, "list" | "read" | "threadPullRequest" | "savePullRequest">;
  auth: AuthProvider;
  trustedOrigins: readonly string[];
  /** Server-only App slug. When set, only this App's installations are listed. */
  appSlug?: string;
};

export function registerGitHubReadRoutes(app: FastifyInstance, options: GithubReadOptions) {
  app.register(async (routes) => {
    routes.addHook("onSend", async (_request, reply, payload) => {
      reply.header("Cache-Control", "no-store");

      return payload;
    });
    routes.setErrorHandler((error, request, reply) => {
      if (error instanceof z.ZodError)
        return reply
          .code(400)
          .send({ error: { code: "INVALID_REQUEST", message: "Invalid GitHub request" } });

      return sendFailure(request, reply, error);
    });

    async function readUserId(request: FastifyRequest) {
      const context = await createContext(options.auth, request.headers);

      if (!context.session) return gitError("GIT_ACCESS_DENIED", 401);

      return context.session.user.id;
    }

    routes.get("/api/github/installations", async (request) => {
      const query = z
        .object({ page: z.coerce.number().int().min(1).max(1000).default(1) })
        .parse(request.query);

      const installations = await options.github.installations(
        await readUserId(request),
        query.page,
      );

      // Never present another App's installation as selectable.
      if (!options.appSlug) return installations;

      return {
        ...installations,
        items: installations.items.filter((item) => item.appSlug === options.appSlug),
      };
    });

    routes.get("/api/github/repositories", async (request) => {
      const user = await readUserId(request);

      const query = z
        .object({
          page: z.coerce.number().int().min(1).max(1000).default(1),
          installationId: z.coerce.number().int().positive(),
        })
        .parse(request.query);

      return options.github.installationRepositories(user, query.installationId, query.page);
    });

    routes.get("/api/skills", async (request) => {
      await readUserId(request);

      return { skills: imageSkills };
    });

    for (const kind of ["tree", "skills"] as const) {
      routes.get(`/api/github/repositories/:owner/:repo/${kind}`, async (request) => {
        const user = await readUserId(request);
        const params = z.object({ owner: z.string(), repo: z.string() }).parse(request.params);
        const url = normalizeGitHubUrl(`https://github.com/${params.owner}/${params.repo}`);

        if (!url) return gitError("GIT_ACCESS_DENIED", 400);

        const { ref } = z
          .object({ ref: z.string().min(1).max(1024).optional() })
          .parse(request.query);

        return options.github[kind](user, url, ref);
      });
    }

    routes.get("/api/github/repositories/:owner/:repo/branches", async (request) => {
      const params = z.object({ owner: z.string(), repo: z.string() }).parse(request.params);
      const url = normalizeGitHubUrl(`https://github.com/${params.owner}/${params.repo}`);

      if (!url) return gitError("GIT_ACCESS_DENIED", 400);

      return options.github.branches(
        await readUserId(request),
        url,
        z.object({ page: z.coerce.number().int().min(1).max(1000).default(1) }).parse(request.query)
          .page,
      );
    });

    routes.get("/api/threads/:id/pull-request", async (request) => {
      const user = await readUserId(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const linked = await options.store.threadPullRequest(user, id);

      if (!linked) return null;

      if (
        linked.cached?.number === linked.number &&
        Date.now() - Date.parse(linked.cached.checkedAt) < 15_000
      )
        return linked.cached;
      await options.github.repository(user, linked.repositoryUrl);
      const path = `/repos${githubRepositoryPath(linked.repositoryUrl)}`;

      const current = githubPrSchema.parse(
        await options.github.request(user, `${path}/pulls/${linked.number}`),
      );

      const checks = { total: 0, passed: 0, failed: 0, pending: 0 };

      for (let page = 1; page <= 10; page++) {
        const runs = z
          .object({
            total_count: z.number(),
            check_runs: z.array(
              z.object({ status: z.string(), conclusion: z.string().nullable() }),
            ),
          })
          .parse(
            await options.github.request(
              user,
              `${path}/commits/${gitShaSchema.parse(current.head.sha)}/check-runs?per_page=100&page=${page}`,
            ),
          );

        for (const check of runs.check_runs) {
          checks.total++;

          if (check.status !== "completed") checks.pending++;
          else if (["success", "neutral", "skipped"].includes(check.conclusion ?? ""))
            checks.passed++;
          else checks.failed++;
        }

        if (page * 100 >= runs.total_count) break;

        if (page === 10) {
          checks.pending += Math.max(0, runs.total_count - checks.total);
          checks.total = Math.max(checks.total, runs.total_count);
        }
      }

      const statuses = z
        .object({ statuses: z.array(z.object({ context: z.string(), state: z.string() })) })
        .parse(
          await options.github.request(
            user,
            `${path}/commits/${current.head.sha}/status?per_page=100`,
          ),
        );

      for (const status of statuses.statuses) {
        checks.total++;

        if (status.state === "success") checks.passed++;
        else if (status.state === "pending") checks.pending++;
        else checks.failed++;
      }

      const state = current.merged
        ? "merged"
        : current.state === "closed"
          ? "closed"
          : current.draft
            ? "draft"
            : "open";

      const value = {
        number: current.number,
        title: current.title,
        url: current.html_url,
        state,
        checks,
        checkedAt: new Date().toISOString(),
      };

      const validated = threadPrSchema.parse(value);
      await options.store.savePullRequest(user, id, validated);

      return validated;
    });

    routes.get("/api/threads/:id/git-operations", async (request) =>
      options.store.list(
        await readUserId(request),
        z.object({ id: z.uuid() }).parse(request.params).id,
        z.object({ page: z.coerce.number().int().min(1).max(1000).default(1) }).parse(request.query)
          .page,
      ),
    );

    routes.get("/api/threads/:id/git-operations/:operationId", async (request) => {
      const params = z.object({ id: z.uuid(), operationId: z.uuid() }).parse(request.params);
      const operation = await options.store.read(params.operationId);

      if (operation.userId !== (await readUserId(request)) || operation.threadId !== params.id)
        return gitError("GIT_OPERATION_NOT_FOUND", 404);

      return operation;
    });
  });
}
