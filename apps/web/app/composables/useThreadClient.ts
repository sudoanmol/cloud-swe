import { createThreadClient } from "@cloud-swe/api/client";

export function useThreadClient() {
  const config = useRuntimeConfig();
  const raw = (import.meta.server && config.serverUrl) || config.public.serverUrl;
  return createThreadClient({
    baseUrl: String(raw).replace(/\/$/, ""),
  });
}
