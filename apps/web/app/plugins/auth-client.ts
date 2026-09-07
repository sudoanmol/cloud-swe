import { createAuthClient } from "better-auth/vue";

export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig();
  const rawServerUrl = (import.meta.server && config.serverUrl) || config.public.serverUrl;
  // Same-origin paths like /api need an absolute base, and better-auth derives
  // its route matching from this URL's path, so it must be exactly /api/auth
  const serverOrigin = rawServerUrl.startsWith("/")
    ? (import.meta.server ? useRequestURL() : window.location).origin + rawServerUrl
    : rawServerUrl;

  const authClient = createAuthClient({
    baseURL: new URL("/api/auth", serverOrigin).toString(),
  });

  return {
    provide: {
      authClient: authClient,
    },
  };
});
