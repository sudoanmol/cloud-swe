import { expect, test } from "bun:test";
import { failureIdentities } from "../src/failure.js";

test("reads error identities through Error causes and stops at missing causes", () => {
  const cause = Object.assign(new Error("database"), { code: "WORKSPACE_GENERATION_MISMATCH" });
  const error = new Error("activity", { cause });

  expect(failureIdentities(error)).toEqual([
    { type: undefined, code: undefined },
    { type: undefined, code: "WORKSPACE_GENERATION_MISMATCH" },
  ]);
  expect(failureIdentities({ type: "RUN_TIMEOUT" })).toEqual([
    { type: "RUN_TIMEOUT", code: undefined },
  ]);
});

test("stops at cycles and ignores primitive failures", () => {
  const first = new Error("first");
  const second = new Error("second", { cause: first });
  first.cause = second;

  expect(failureIdentities(first)).toHaveLength(2);
  expect(failureIdentities(null)).toEqual([]);
  expect(failureIdentities("failure")).toEqual([]);
});
