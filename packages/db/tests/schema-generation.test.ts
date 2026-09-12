import { expect, test } from "bun:test";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import * as schema from "../src/schema";
import snapshot from "../src/migrations/meta/0012_snapshot.json";

test("the current schema generates no follow-up DDL", async () => {
  expect(await generateMigration(snapshot, generateDrizzleJson(schema, snapshot.id))).toEqual([]);
});
