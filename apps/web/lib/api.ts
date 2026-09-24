import { createApiTransport } from "@cloud-swe/api/client";

/**
 * Fastify API origin. Browser code reads it explicitly and requests cookies
 * directly; there is no Next.js proxy/rewrite in front of the backend.
 */
export const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export const api = createApiTransport({ baseUrl: apiBaseUrl, credentials: "include" });
