import { auth } from "@cloud-swe/auth";
import { OpenAPIHandler } from "@orpc/openapi/fastify";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fastify";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import type { FastifyInstance } from "fastify";

import { createContext } from "./context";
import { appRouter } from "./routers/index";
import { registerThreadRoutes, type ThreadRouteOptions } from "./routers/thread";

export type ApiRouteOptions = ThreadRouteOptions;

export function registerApiRoutes(app: FastifyInstance, options: ApiRouteOptions): void {
  const rpcHandler = new RPCHandler(appRouter, {
    interceptors: [onError((error) => app.log.error({ err: error }, "RPC request failed"))],
  });
  const apiHandler = new OpenAPIHandler(appRouter, {
    plugins: [new OpenAPIReferencePlugin({ schemaConverters: [new ZodToJsonSchemaConverter()] })],
    interceptors: [onError((error) => app.log.error({ err: error }, "RPC request failed"))],
  });

  app.register(async (rpcApp) => {
    rpcApp.addContentTypeParser("*", (_, _payload, done) => done(null, undefined));
    rpcApp.all("/rpc/*", async (request, reply) => {
      const { matched } = await rpcHandler.handle(request, reply, {
        context: await createContext(request.headers),
        prefix: "/rpc",
      });
      if (!matched) reply.status(404).send();
    });
    rpcApp.all("/api-reference/*", async (request, reply) => {
      const { matched } = await apiHandler.handle(request, reply, {
        context: await createContext(request.headers),
        prefix: "/api-reference",
      });
      if (!matched) reply.status(404).send();
    });
  });

  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    handler: async (request, reply) => {
      try {
        const url = new URL(request.url, `http://${request.headers.host}`);
        const headers = new Headers();
        Object.entries(request.headers).forEach(([key, value]) => {
          if (value) headers.append(key, value.toString());
        });
        const req = new Request(url.toString(), {
          method: request.method,
          headers,
          body: request.body ? JSON.stringify(request.body) : undefined,
        });
        const response = await auth.handler(req);
        reply.status(response.status);
        response.headers.forEach((value, key) => reply.header(key, value));
        reply.send(response.body ? await response.text() : null);
      } catch (error) {
        app.log.error({ err: error }, "Authentication Error");
        reply.status(500).send({ error: "Internal authentication error", code: "AUTH_FAILURE" });
      }
    },
  });

  app.get("/", async () => "OK");
  registerThreadRoutes(app, options);
}
