import type { FastifyInstance } from "fastify";
import type { AgentBrowsers } from "@cloud-swe/db/agent-browsers";
import { reachableSandbox, type ThreadStore } from "@cloud-swe/db/thread-contracts";
import { z } from "zod";

import { browserControlBodySchema, type BrowserState } from "../contracts";
import { sendError, sendFailure } from "../http";

export interface BrowserRouteOptions {
  store: Pick<
    ThreadStore,
    | "readRepository"
    | "readWorkspace"
    | "readBrowserOwner"
    | "changeBrowserOwner"
    | "touchWorkspaceReview"
  >;
  /** Absent when the hosted browser is not configured. */
  browsers?: Pick<AgentBrowsers, "find" | "ensure">;
}

const idParam = z.object({ id: z.uuid() });

export function registerBrowserRoutes(app: FastifyInstance, options: BrowserRouteOptions) {
  app.get("/api/threads/:id/browser", async (request, reply) => {
    const userId = request.threadUserId;
    const params = idParam.safeParse(request.params);

    if (!userId) return;

    if (!params.success) return sendError(reply, 400, "INVALID_THREAD_ID", "Invalid thread ID");

    if (!options.browsers)
      return sendError(reply, 503, "BROWSER_UNAVAILABLE", "The hosted browser is not configured");
    const threadId = params.data.id;

    try {
      await options.store.readRepository({ userId, threadId });
      const owner = await options.store.readBrowserOwner(threadId);
      let live = await options.browsers.find(threadId);

      if (
        !live &&
        owner === "user" &&
        reachableSandbox(await options.store.readWorkspace(threadId))
      )
        live = await options.browsers.ensure(threadId);
      // The panel polls while open; someone watching keeps the workspace awake.
      await options.store.touchWorkspaceReview(threadId);

      return reply.send({
        owner,
        liveViewUrl: live?.liveViewUrl ?? null,
      } satisfies BrowserState);
    } catch (error) {
      return sendFailure(request, reply, error);
    }
  });

  app.post("/api/threads/:id/browser/control", async (request, reply) => {
    const userId = request.threadUserId;
    const params = idParam.safeParse(request.params);
    const body = browserControlBodySchema.safeParse(request.body);

    if (!userId) return;

    if (!params.success || !body.success)
      return sendError(reply, 400, "INVALID_PAYLOAD", "Invalid browser control request");

    try {
      await options.store.changeBrowserOwner({
        userId,
        threadId: params.data.id,
        owner: body.data.owner,
      });

      return reply.send({ owner: body.data.owner });
    } catch (error) {
      return sendFailure(request, reply, error);
    }
  });
}
