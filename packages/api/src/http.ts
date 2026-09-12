import type { FastifyReply, FastifyRequest } from "fastify";
import { publicFailure } from "@cloud-swe/db/public-failure";

export function sendError(reply: FastifyReply, statusCode: number, code: string, message: string) {
  return reply.status(statusCode).send({ error: { code, message } });
}

/** Log only the stable classification. Caught SDK errors can contain secrets. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Caught SDK failures are projected to safe fields before logging.
export function logFailure(request: FastifyRequest, error: unknown, message: string): void {
  const failure = publicFailure(error);
  request.log.error({ code: failure.code, statusCode: failure.statusCode }, message);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Caught failures are projected to a bounded response.
export function sendFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Caught failures are projected to a bounded response.
  error: unknown,
  fallbackStatusCode?: number,
) {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- publicFailure validates and projects the caught value.
  const failure = publicFailure(error);
  const statusCode = fallbackStatusCode ?? failure.statusCode;
  logFailure(request, error, "Request failed");

  return sendError(reply, statusCode, failure.code, failure.message);
}
