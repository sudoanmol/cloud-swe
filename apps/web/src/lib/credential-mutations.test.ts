/// <reference types="bun" />
import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { saveProviderKeyMutation } from "./queries";

test("settling a credential request removes only its own plaintext variables", async () => {
  const client = new QueryClient();
  const cache = client.getMutationCache();
  const key = ["session", "alice", "provider-credentials", "openrouter"];
  const firstResponse = Promise.withResolvers<undefined>();
  const nextResponse = Promise.withResolvers<undefined>();

  const first = cache.build(client, {
    ...saveProviderKeyMutation(key),
    mutationFn: () => firstResponse.promise,
  });

  const next = cache.build(client, {
    ...saveProviderKeyMutation(key),
    mutationFn: () => nextResponse.promise,
  });

  const firstRequest = first.execute({ provider: "openrouter", apiKey: "old-key" });
  const nextRequest = next.execute({ provider: "openrouter", apiKey: "new-key" });

  firstResponse.resolve(undefined);
  await firstRequest;
  expect(cache.getAll().map((mutation) => mutation.mutationId)).toEqual([next.mutationId]);
  nextResponse.resolve(undefined);
  await nextRequest;
  expect(cache.getAll()).toEqual([]);
  client.clear();
});
