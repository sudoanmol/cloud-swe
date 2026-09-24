/// <reference types="bun" />
import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { OptimisticMessage } from "./chat-types";
import {
  clearEnvelope,
  createEnvelope,
  loadEnvelope,
  saveEnvelope,
  submissionBody,
  type SubmissionEnvelope,
} from "./submission";
import { addOptimistic, clearOptimistic, optimisticQueryOptions } from "./optimistic";

const threadId = "11111111-1111-4111-8111-111111111111";

const attachmentId = "22222222-2222-4222-8222-222222222222";

const selection: SubmissionEnvelope["modelSelection"] = {
  provider: "openrouter",
  model: "test-model",
  thinkingLevel: "off",
};

function storage() {
  const data = new Map<string, string>();

  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

test("an uncertain submission survives reload byte-identically and cannot cross account/thread scopes", () => {
  const store = storage();
  const modelSelection = { ...selection };

  const envelope = createEnvelope({
    prompt: "build it",
    modelSelection,
    attachmentIds: [attachmentId],
    repositoryUrl: "https://github.com/example/repo",
    branch: "main",
  });

  const request = JSON.stringify(submissionBody(envelope));
  modelSelection.model = "changed-after-click";
  saveEnvelope(store, "alice", envelope);
  expect(JSON.stringify(submissionBody(envelope))).toBe(request);
  const restored = loadEnvelope(store, "alice", undefined);
  expect(restored).toEqual(envelope);

  if (!restored) throw new Error("Envelope was lost");
  expect(JSON.stringify(submissionBody(restored))).toBe(request);
  expect(loadEnvelope(store, "bob", undefined)).toBeNull();
  expect(loadEnvelope(store, "alice", threadId)).toBeNull();
  clearEnvelope(store, "alice", undefined);
  expect(loadEnvelope(store, "alice", undefined)).toBeNull();
});

test("attachment-only follow-ups retain explicit model selection and omit repository fields", () => {
  const envelope = createEnvelope({
    prompt: "",
    attachmentIds: [attachmentId],
    modelSelection: selection,
    threadId,
  });

  expect(submissionBody(envelope)).toEqual({
    path: `/api/threads/${threadId}/messages`,
    body: {
      prompt: "",
      attachmentIds: [attachmentId],
      modelSelection: selection,
      clientMessageId: envelope.clientMessageId,
    },
  });
  const store = storage();
  store.setItem(
    `cloud-swe:submission:alice:${threadId}`,
    JSON.stringify({ ...envelope, threadId: attachmentId }),
  );
  expect(loadEnvelope(store, "alice", threadId)).toBeNull();
});

test("accepted prompt cache dedupes identities and is cleared on account reset", () => {
  const client = new QueryClient();

  const message = {
    threadId,
    runId: "run",
    clientMessageId: "client",
    text: "prompt",
    attachmentIds: [],
  };

  addOptimistic(client, "alice", message);
  addOptimistic(client, "alice", message);
  expect(
    client.getQueryData<OptimisticMessage[]>(optimisticQueryOptions("alice", threadId).queryKey),
  ).toEqual([message]);
  expect(client.getQueryData(optimisticQueryOptions("bob", threadId).queryKey)).toBeUndefined();
  clearOptimistic(client, "alice", threadId, ["client"]);
  expect(
    client.getQueryData<OptimisticMessage[]>(optimisticQueryOptions("alice", threadId).queryKey),
  ).toEqual([]);
  addOptimistic(client, "alice", message);
  client.clear();
  expect(client.getQueryData(optimisticQueryOptions("alice", threadId).queryKey)).toBeUndefined();
});
