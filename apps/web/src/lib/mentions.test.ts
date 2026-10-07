import { expect, test } from "bun:test";
import { filterMentions, insertMention, mentionAt, mentionKey, type MentionItem } from "./mentions";

const items: MentionItem[] = [
  { group: "Files", label: "src/components/composer.tsx", value: "@src/components/composer.tsx" },
  { group: "Files", label: "docs/contract.md", value: "@docs/contract.md" },
  { group: "Skills", label: "browser", value: "$browser", description: "Automate web pages" },
];

test("mentions use cmdk fuzzy scores for paths and skill descriptions", () => {
  expect(filterMentions(items, "srccmp").map((item) => item.value)).toEqual([
    "@src/components/composer.tsx",
  ]);
  expect(filterMentions(items, "pages").map((item) => item.value)).toEqual(["$browser"]);
  expect(filterMentions(items, "not-found")).toEqual([]);
});

test("arrow keys wrap, Enter and Tab insert, Escape closes, and empty results consume insertion", () => {
  expect(mentionKey("ArrowDown", items, items[0]!.value)).toEqual({
    kind: "move",
    value: items[1]!.value,
  });
  expect(mentionKey("ArrowUp", items, items[0]!.value)).toEqual({
    kind: "move",
    value: "$browser",
  });
  expect(mentionKey("ArrowDown", items, "$browser")).toEqual({
    kind: "move",
    value: items[0]!.value,
  });

  for (const key of ["Enter", "Tab"])
    expect(mentionKey(key, items, "$browser")).toEqual({ kind: "insert", value: "$browser" });
  expect(mentionKey("Escape", items, "")).toEqual({ kind: "close" });
  expect(mentionKey("Enter", [], "")).toEqual({ kind: "insert", value: undefined });
  expect(mentionKey("a", items, "")).toBeNull();
});

test("insertion replaces the token at the caret and preserves the rest of the prompt", () => {
  const text = "Read @src/old and explain";
  const mention = mentionAt(text, 9);
  expect(mention).toEqual({ start: 5, end: 13, query: "src" });

  if (!mention) throw new Error("Expected mention");
  expect(insertMention(text, mention, "@src/new.ts")).toEqual({
    text: "Read @src/new.ts  and explain",
    caret: 17,
  });
  expect(insertMention("@bro", { start: 0, end: 4, query: "bro" }, "$browser")).toEqual({
    text: "$browser ",
    caret: 9,
  });
  expect(mentionAt("email@example.com", 17)).toBeNull();
  expect(mentionAt("@src/file done", 14)).toBeNull();
});

test("large catalogs keep skill results available alongside the first 50 files", () => {
  const catalog = [
    ...Array.from({ length: 25_000 }, (_, index): MentionItem => ({
      group: "Files",
      label: `src/file-${index}.ts`,
      value: `@src/file-${index}.ts`,
    })),
    items[2]!,
  ];

  expect(filterMentions(catalog, "").length).toBe(51);
  expect(filterMentions(catalog, "").at(-1)?.value).toBe("$browser");
});
