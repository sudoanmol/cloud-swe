import type { FastifyRequest } from "fastify";

const stateChangingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type SecurityOptions = {
  trustedOrigins: readonly string[];
  requireJsonBody?: boolean;
  requireCsrfHeader?: boolean;
};

export type SecurityError = {
  code: "CSRF_FORBIDDEN" | "INVALID_CONTENT_TYPE";
  message: string;
};

function normalizeOrigin(value: string): string | null {
  try {
    const origin = new URL(value).origin;

    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value.length === 1 ? (value[0] ?? null) : null;

  return value ?? null;
}

function isJsonContentType(value: string | string[] | undefined): boolean {
  const contentType = headerValue(value);

  if (!contentType) return false;

  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

export function checkMutationSecurity(
  request: FastifyRequest,
  options: SecurityOptions,
): SecurityError | null {
  if (!stateChangingMethods.has(request.method)) return null;

  const origin = headerValue(request.headers.origin);

  const trustedOrigins = new Set(
    options.trustedOrigins.map(normalizeOrigin).filter((value): value is string => value !== null),
  );

  const csrfHeader = options.requireCsrfHeader ?? true;

  if (!origin || !trustedOrigins.has(origin)) {
    return {
      code: "CSRF_FORBIDDEN",
      message: "A trusted Origin is required",
    };
  }

  if (csrfHeader && request.headers["x-csrf-protection"] !== "1") {
    return {
      code: "CSRF_FORBIDDEN",
      message: "X-CSRF-Protection: 1 is required",
    };
  }

  if (options.requireJsonBody && !isJsonContentType(request.headers["content-type"])) {
    return {
      code: "INVALID_CONTENT_TYPE",
      message: "JSON request bodies must use Content-Type: application/json",
    };
  }

  return null;
}

export function hasRequestBody(request: FastifyRequest): boolean {
  return request.body !== undefined && request.body !== null;
}

export function readHeader(value: string | string[] | undefined): string | undefined {
  return headerValue(value) ?? undefined;
}
