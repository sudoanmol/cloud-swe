import { registerGitBroker, type GitBrokerOptions } from "@cloud-swe/api/routers/git-broker";
import { registerApiRoutes, type ApiRouteOptions } from "@cloud-swe/api/routes";
import { env } from "@cloud-swe/env/server";
import fastifyCors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

export interface ServerOptions extends ApiRouteOptions {
  git?: Omit<GitBrokerOptions, "auth" | "trustedOrigins">;
  logger?: FastifyServerOptions["logger"];
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

  const loggerOptions =
    options.logger === true || options.logger === undefined || options.logger === false
      ? undefined
      : options.logger;

  const fastify = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            ...loggerOptions,
            serializers: {
              req: (request) => ({
                method: request.method,
                url: request.url?.split("?")[0],
                hostname: request.hostname,
                remoteAddress: request.ip,
              }),
            },
          },
  });

  fastify.register(fastifyCors, baseCorsConfig);
  registerApiRoutes(fastify, options);

  if (options.git)
    registerGitBroker(fastify, {
      ...options.git,
      auth: options.auth,
      trustedOrigins: options.trustedOrigins,
    });

  return fastify;
}
