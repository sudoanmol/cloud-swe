import { registerApiRoutes, type ApiRouteOptions } from "@cloud-swe/api/routes";
import { env } from "@cloud-swe/env/server";
import fastifyCors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";

export interface ServerOptions extends ApiRouteOptions {
  logger?: boolean;
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const baseCorsConfig = {
    origin: env.CORS_ORIGIN,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "X-CSRF-Protection",
      "Last-Event-ID",
    ],
    credentials: true,
    maxAge: 86400,
  };

  const fastify = Fastify({ logger: options.logger ?? true });

  fastify.register(fastifyCors, baseCorsConfig);
  registerApiRoutes(fastify, options);

  return fastify;
}
