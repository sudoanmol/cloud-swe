/// <reference types="bun" />
import { expect, test } from "bun:test";
import { clearAccountStorage } from "./account-storage";

function storage(): Storage {
  const data = new Map<string, string>();

  return {
    get length() {
      return data.size;
    },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
    clear: () => data.clear(),
  };
}

test("signout clears every departing-account draft/envelope without touching another account or preferences", () => {
  const session = storage();
  const local = storage();

  const removed = [
    "cloud-swe:draft:alice:new-thread",
    "cloud-swe:submission:alice:new",
    "cloud-swe:draft:alice:thread:123",
  ];

  for (const key of [
    ...removed,
    "cloud-swe:draft:alice2:new-thread",
    "cloud-swe:submission:bob:new",
    "theme",
  ])
    session.setItem(key, "saved");
  local.setItem("cloud-swe:model-selection:alice", "model");
  local.setItem("cloud-swe:repository-selection:alice", "repository");
  local.setItem("cloud-swe:environment-selection:alice", "environment-id");
  local.setItem("theme", "dark");
  clearAccountStorage("alice", session, local);

  for (const key of removed) expect(session.getItem(key)).toBeNull();
  expect(session.length).toBe(3);
  expect(local.getItem("cloud-swe:model-selection:alice")).toBeNull();
  expect(local.getItem("cloud-swe:repository-selection:alice")).toBeNull();
  expect(local.getItem("cloud-swe:environment-selection:alice")).toBeNull();
  expect(local.getItem("theme")).toBe("dark");
});
