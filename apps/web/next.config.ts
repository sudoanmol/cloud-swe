import type { NextConfig } from "next";
import { z } from "zod";
import { loadRootEnv } from "../../packages/env/src/load-root-env";

loadRootEnv();

const apiUrl = z.url({ protocol: /^https?$/ }).parse(process.env.NEXT_PUBLIC_API_URL);

/**
 * The product UI talks to the Fastify API over `NEXT_PUBLIC_API_URL`; there is
 * no Next-side backend, proxy or image host in this app.
 */
const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_API_URL: apiUrl },
  cacheComponents: true,
  devIndicators: false,
  experimental: {
    appNewScrollHandler: true,
    cachedNavigations: true,
    inlineCss: true,
    prefetchInlining: true,
    turbopackFileSystemCacheForDev: true,
  },
  logging: {
    fetches: {
      fullUrl: false,
    },
    incomingRequests: false,
  },
  poweredByHeader: false,
  reactCompiler: true,
};

export default nextConfig;
