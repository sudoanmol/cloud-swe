import { defaultFilter } from "cmdk";

export type MentionItem = {
  value: string;
  label: string;
  description?: string;
  group: "Files" | "Skills";
};

export function mentionAt(text: string, caret: number) {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));

  if (!match) return null;
  const query = match[1] ?? "";

  return {
    start: caret - query.length - 1,
    end: caret + (/^[^\s@]*/.exec(text.slice(caret))?.[0].length ?? 0),
    query,
  };
}

export function filterMentions(items: MentionItem[], search: string) {
  return (["Files", "Skills"] as const).flatMap((group) =>
    items
      .flatMap((item) => {
        if (item.group !== group) return [];
        const score = defaultFilter(item.label, search, item.description ? [item.description] : []);

        return score > 0 ? [{ item, score }] : [];
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map(({ item }) => item),
  );
}

export function mentionKey(key: string, items: MentionItem[], selected: string) {
  if (key === "Escape") return { kind: "close" } as const;

  const index = Math.max(
    0,
    items.findIndex((item) => item.value === selected),
  );

  if (key === "Enter" || key === "Tab")
    return { kind: "insert", value: items.at(index)?.value } as const;

  if (key === "ArrowDown" || key === "ArrowUp") {
    const next = items.at((index + (key === "ArrowDown" ? 1 : items.length - 1)) % items.length);

    return { kind: "move", value: next?.value ?? "" } as const;
  }

  return null;
}

export function insertMention(
  text: string,
  mention: NonNullable<ReturnType<typeof mentionAt>>,
  value: string,
) {
  return {
    text: text.slice(0, mention.start) + value + " " + text.slice(mention.end),
    caret: mention.start + value.length + 1,
  };
}
