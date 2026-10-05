import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ThreadStore } from "@cloud-swe/db/thread-contracts";
import {
  reviewDiffSchema,
  reviewEnvelopeSchema,
  reviewModeSchema,
  reviewSummarySchema,
  workspaceFileSchema,
  workspacePathsSchema,
} from "@cloud-swe/db/workspace-review";
import { z } from "zod";

import { sendError, sendFailure } from "../http";
import type { WorkspaceReviewRunner } from "../workspace-sandbox";

export type WorkspaceReviewStore = Pick<
  ThreadStore,
  "readRepository" | "readWorkspace" | "requestWorkspaceWake" | "touchWorkspaceReview"
>;

export interface WorkspaceRouteOptions {
  store: WorkspaceReviewStore;
  /** Absent when the server has no Modal credentials. */
  run?: WorkspaceReviewRunner;
}

const idParam = z.object({ id: z.uuid() });

const diffQuery = z
  .object({
    mode: reviewModeSchema,
    commit: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
  })
  .refine((query) => (query.mode === "commit") === (query.commit !== undefined), {
    message: "commit is required for and only for commit mode",
  });

const fileQuery = z.object({
  path: z
    .string()
    .min(1)
    .max(4_096)
    .refine((path) => !path.startsWith("/") && !path.split("/").includes("..")),
});

/** Guest stdout is untrusted; malformed JSON fails schema validation like any bad shape. */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- Callers validate the parsed value with a Zod schema.
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function registerWorkspaceRoutes(app: FastifyInstance, options: WorkspaceRouteOptions) {
  /**
   * Resolves the caller's running sandbox, or answers why it cannot be read.
   * A paused workspace is a normal state: the client asks to wake it.
   */
  async function target(request: FastifyRequest, reply: FastifyReply) {
    const userId = request.threadUserId;
    const params = idParam.safeParse(request.params);

    if (!userId) return null;

    if (!params.success) {
      sendError(reply, 400, "INVALID_THREAD_ID", "Invalid thread ID");

      return null;
    }

    const threadId = params.data.id;
    const { repositoryBranch } = await options.store.readRepository({ userId, threadId });
    const workspace = await options.store.readWorkspace(threadId);

    if (!options.run) {
      sendError(reply, 503, "REVIEW_UNAVAILABLE", "Workspace review is not configured");

      return null;
    }

    if (
      workspace?.state !== "running" ||
      workspace.lifecycleTransitionId ||
      workspace.provider !== "modal" ||
      !workspace.providerId
    ) {
      sendError(
        reply,
        409,
        workspace?.state === "paused" ? "WORKSPACE_PAUSED" : "WORKSPACE_NOT_RUNNING",
        "The workspace is not running",
      );

      return null;
    }

    return { threadId, branch: repositoryBranch ?? "", providerId: workspace.providerId };
  }

  async function review(
    request: FastifyRequest,
    reply: FastifyReply,
    schema: z.ZodType,
    args: (branch: string) => string[],
  ) {
    try {
      const resolved = await target(request, reply);

      if (!resolved) return;
      // Reading the panel counts as activity, so the idle pause waits for it.
      await options.store.touchWorkspaceReview(resolved.threadId);
      let stdout: string;

      try {
        stdout = await options.run!(resolved.providerId, args(resolved.branch));
      } catch {
        // Usually a pause racing the read; the client retries or wakes it.
        return sendError(reply, 503, "WORKSPACE_UNAVAILABLE", "The workspace did not respond");
      }

      const envelope = reviewEnvelopeSchema(schema).safeParse(parseJson(stdout));

      if (!envelope.success)
        return sendError(reply, 502, "REVIEW_INVALID", "The workspace returned an invalid result");

      if (!envelope.data.ok) return sendError(reply, 422, "REVIEW_FAILED", envelope.data.error);

      return reply.send(envelope.data.result);
    } catch (error) {
      return sendFailure(request, reply, error);
    }
  }

  app.get("/api/threads/:id/workspace/summary", (request, reply) =>
    review(request, reply, reviewSummarySchema, (branch) => ["summary", branch]),
  );

  app.get("/api/threads/:id/workspace/diff", (request, reply) => {
    const query = diffQuery.safeParse(request.query);

    if (!query.success) return sendError(reply, 400, "INVALID_QUERY", "Invalid diff query");
    const { mode, commit } = query.data;

    return review(request, reply, reviewDiffSchema, (branch) => [
      "review",
      branch,
      mode,
      ...(commit ? [commit] : []),
    ]);
  });

  app.get("/api/threads/:id/workspace/files", (request, reply) =>
    review(request, reply, workspacePathsSchema, () => ["files"]),
  );

  app.get("/api/threads/:id/workspace/file", (request, reply) => {
    const query = fileQuery.safeParse(request.query);

    if (!query.success) return sendError(reply, 400, "INVALID_QUERY", "Invalid file path");

    return review(request, reply, workspaceFileSchema, () => ["read", query.data.path]);
  });

  app.post("/api/threads/:id/workspace/wake", async (request, reply) => {
    const userId = request.threadUserId;
    const params = idParam.safeParse(request.params);

    if (!userId) return;

    if (!params.success) return sendError(reply, 400, "INVALID_THREAD_ID", "Invalid thread ID");

    try {
      await options.store.readRepository({ userId, threadId: params.data.id });
      const outcome = await options.store.requestWorkspaceWake(params.data.id);

      if (outcome === "active-run")
        return sendError(
          reply,
          409,
          "RUN_ACTIVE",
          "The workspace resumes when the waiting run continues",
        );

      return reply.status(202).send({ outcome });
    } catch (error) {
      return sendFailure(request, reply, error);
    }
  });
}
