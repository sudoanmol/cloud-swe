import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { createContext, type AuthProvider } from "./context";
import { checkMutationSecurity, hasRequestBody } from "./security";
import { registerThreadRoutes, type ThreadRouteOptions } from "./routers/thread";
import { logFailure, sendError } from "./http";

export type ApiRouteOptions = ThreadRouteOptions;

function requestBody(request: FastifyRequest): string | undefined {
  if (request.body === undefined || request.body === null) return undefined;

  const text = z.string().safeParse(request.body);

  if (text.success) return text.data;

  return JSON.stringify(request.body);
}

function toAuthRequest(request: FastifyRequest): Request {
  const host = request.headers.host;
  const url = new URL(request.url, `http://${host ?? "localhost"}`);
  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  return new Request(url.toString(), {
    method: request.method,
    headers,
    body: requestBody(request),
  });
}

async function sendAuthResponse(reply: FastifyReply, response: Response): Promise<void> {
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") reply.header(key, value);
  });
  const cookies = response.headers.getSetCookie?.() ?? [];

  if (cookies.length > 0) reply.header("set-cookie", cookies);
  else {
    const cookie = response.headers.get("set-cookie");

    if (cookie) reply.header("set-cookie", cookie);
  }

  reply.status(response.status);
  reply.send(response.body ? await response.text() : null);
}

async function handleAuthRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: AuthProvider,
  trustedOrigins: readonly string[],
): Promise<void> {
  const securityError = checkMutationSecurity(request, {
    trustedOrigins,
    requireCsrfHeader: false,
    requireJsonBody: hasRequestBody(request),
  });

  if (securityError) {
    sendError(reply, 403, securityError.code, securityError.message);

    return;
  }

  try {
    await sendAuthResponse(reply, await auth.handler(toAuthRequest(request)));
  } catch (error) {
    logFailure(request, error, "Authentication request failed");
    sendError(reply, 500, "AUTH_FAILURE", "Unable to process authentication request");
  }
}

export function registerApiRoutes(app: FastifyInstance, options: ApiRouteOptions): void {
  app.route({
    method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    url: "/api/auth/*",
    handler: (request, reply) =>
      handleAuthRequest(request, reply, options.auth, options.trustedOrigins),
  });

  app.get("/", async () => "OK");
  registerThreadRoutes(app, options);
}

export { createContext };

export type { AuthProvider };
