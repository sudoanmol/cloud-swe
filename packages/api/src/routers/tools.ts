import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  composioUnavailable,
  disabledComposioToolkits,
  type ComposioSessions,
} from "@cloud-swe/db/composio";
import { sendError, sendFailure } from "../http";

const catalogQuery = z.object({
  search: z.string().trim().max(100).optional(),
  cursor: z.string().max(512).optional(),
});

const connectBody = z
  .object({
    toolkit: z
      .string()
      .regex(/^[a-z0-9_]+$/)
      .max(100),
    returnTo: z.enum(["/onboarding", "/settings"]),
  })
  .strict();

type ComposioSession = Awaited<ReturnType<ComposioSessions["resolve"]>>;

export type ToolsSessions = {
  ensure: ComposioSessions["ensure"];
  resolve: (userId: string) => Promise<{
    toolkits: ComposioSession["toolkits"];
    authorize: (
      ...args: Parameters<ComposioSession["authorize"]>
    ) => Promise<Pick<Awaited<ReturnType<ComposioSession["authorize"]>>, "redirectUrl">>;
  }>;
};

/** Inside the existing authenticated and CSRF-protected scope. */
export function registerToolsRoutes(
  routes: FastifyInstance,
  options: { sessions?: ToolsSessions; appOrigin?: string },
) {
  routes.get("/api/tools", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const userId = request.threadUserId;

    if (!userId) return;

    if (!options.sessions) return { enabled: false, items: [], recommended: [], cursor: null };
    const query = catalogQuery.safeParse(request.query);

    if (!query.success) return sendError(reply, 400, "INVALID_PAYLOAD", "Invalid toolkit search");

    try {
      await options.sessions.ensure(userId);
      const session = await options.sessions.resolve(userId);

      const [page, recommended] = await Promise.all([
        session.toolkits({ ...query.data, limit: 20 }),
        session.toolkits({ toolkits: ["firecrawl", "context7_mcp"], limit: 2 }),
      ]);

      // Project only UI fields. Never serialize the SDK session or auth state.
      return {
        enabled: true,
        items: page.items.flatMap((toolkit) =>
          disabledComposioToolkits.includes(toolkit.slug)
            ? []
            : [
                {
                  slug: toolkit.slug,
                  name: toolkit.name,
                  connected: toolkit.isNoAuth || toolkit.connection?.isActive === true,
                },
              ],
        ),
        recommended: recommended.items.map((toolkit) => ({
          slug: toolkit.slug,
          name: toolkit.name,
          connected: toolkit.isNoAuth || toolkit.connection?.isActive === true,
        })),
        cursor: page.cursor ?? null,
      };
    } catch {
      return sendFailure(request, reply, composioUnavailable());
    }
  });
  routes.post("/api/tools/connect", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const userId = request.threadUserId;

    if (!userId) return;

    if (!options.sessions || !options.appOrigin)
      return sendError(reply, 503, "TOOLS_UNAVAILABLE", "Tools are unavailable");
    const body = connectBody.safeParse(request.body);

    if (!body.success)
      return sendError(reply, 400, "INVALID_PAYLOAD", "Invalid toolkit connection");

    if (disabledComposioToolkits.includes(body.data.toolkit))
      return sendError(reply, 400, "INVALID_PAYLOAD", "This toolkit is unavailable");

    try {
      await options.sessions.ensure(userId);
      const session = await options.sessions.resolve(userId);

      const link = await session.authorize(body.data.toolkit, {
        callbackUrl: new URL(body.data.returnTo, options.appOrigin).href,
      });

      const redirect = new URL(z.url().parse(link.redirectUrl));

      if (redirect.protocol !== "https:" || redirect.username || redirect.password)
        throw composioUnavailable();

      return { redirectUrl: redirect.href };
    } catch {
      return sendFailure(request, reply, composioUnavailable());
    }
  });
}
