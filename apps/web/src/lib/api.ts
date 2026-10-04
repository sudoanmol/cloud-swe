import { createApiTransport } from "@cloud-swe/api/client";

/**
 * Fastify API origin. Browser code reads it explicitly and requests cookies
 * directly; there is no proxy/rewrite in front of the backend. `vite.config.ts`
 * validates it for builds; the fallback serves unit tests.
 */
export const apiBaseUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export const api = createApiTransport({ baseUrl: apiBaseUrl, credentials: "include" });
