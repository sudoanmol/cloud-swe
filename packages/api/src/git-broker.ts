import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  gitContextSchema,
  gitProposalSchema,
  gitReadSchema,
  gitRequestSchema,
  gitShaSchema,
  proposalDigest,
  type GitContext,
  type GitProposal,
  type GitRequest,
} from "@cloud-swe/db/git-contracts";
import { gitError, type GitStore } from "@cloud-swe/db/git-store";
import { publicFailure } from "@cloud-swe/db/public-failure";
import { normalizeGitHubUrl } from "@cloud-swe/db/repository-url";
import { createContext, type AuthProvider } from "./context";
import { checkMutationSecurity } from "./security";
import { sendFailure } from "./http";
import {
  githubCommentSchema,
  githubPrSchema,
  githubRepositoryPath,
  type GithubClient,
} from "./github";
import type { createGitBundles } from "./git-bundles";

const pageSchema = z.object({ page: z.coerce.number().int().min(1).max(1000).default(1) });

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

    let details: Pick<GitProposal, "expectedHead" | "base" | "commit" | "bundleHash" | "preview"> =
      proposal;

    if (request.kind === "push") {
      if (!push) return gitError("GIT_BUNDLE_INVALID");
      details = {
        ...proposal,
        ...(await bundles.prepare(
          id,
          push.commit,
          value.repositoryUrl,
          request.branch,
          await github.token(value.current.userId),
        )),
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
      details = {
        ...proposal,
        expectedHead,
        base: request.base,
        preview: JSON.stringify({ request: marked, expectedHead }),
      };
    } else {
      const current = await pr(value.current.userId, value.repositoryUrl, request.number);

      if (current.base.repo.id !== value.repository.id) return gitError("GIT_PROPOSAL_STALE");

      if (request.kind === "pr_comment")
        proposal.request = {
          ...request,
          body: `${request.body}\n\n<!-- cloud-swe-operation:${id} -->`,
        };
      details = {
        ...proposal,
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
      } else if (r.kind === "pr_create" || r.kind === "pr_comment") {
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
                  await github.request(user, `${path}/issues/${r.number}/comments`, {
                    method: "POST",
                    body: { body: r.body },
                  }),
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
                      `${path}/issues/${r.number}/comments?per_page=100&page=${page}`,
                    ),
                  );

          const found = results.find(
            (item) =>
              item.body === r.body && item.body.includes(`<!-- cloud-swe-operation:${id} -->`),
          );

          if (found) return await store.finish(id, "succeeded", { url: found.html_url });

          if (results.length < 100) break;
        }
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

        const matches =
          r.kind === "pr_merge"
            ? current.merged && current.head.sha === p.expectedHead
            : r.kind === "pr_close"
              ? current.state === "closed" && !current.merged
              : r.kind === "pr_reopen"
                ? current.state === "open"
                : (r.title === undefined || current.title === r.title) &&
                  (r.body === undefined || current.body === r.body);

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
    routes.get("/api/github/repositories", async (request) =>
      github.repositories(await userId(request), pageSchema.parse(request.query).page),
    );
    routes.get("/api/github/repositories/:owner/:repo/branches", async (request) => {
      const params = z.object({ owner: z.string(), repo: z.string() }).parse(request.params);
      const url = normalizeGitHubUrl(`https://github.com/${params.owner}/${params.repo}`);

      if (!url) return gitError("GIT_ACCESS_DENIED", 400);

      return github.branches(await userId(request), url, pageSchema.parse(request.query).page);
    });
    routes.get("/api/threads/:id/git-operations", async (request) =>
      store.list(
        await userId(request),
        z.object({ id: z.uuid() }).parse(request.params).id,
        pageSchema.parse(request.query).page,
      ),
    );
    routes.get("/api/threads/:id/git-operations/:operationId", async (request) => {
      const params = z.object({ id: z.uuid(), operationId: z.uuid() }).parse(request.params);
      const op = await store.read(params.operationId);

      if (op.userId !== (await userId(request)) || op.threadId !== params.id)
        return gitError("GIT_OPERATION_NOT_FOUND", 404);

      return op;
    });
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
