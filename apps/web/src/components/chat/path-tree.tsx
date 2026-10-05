import { useEffect, useRef } from "react";
import type { GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";

export type PathCounts = ReadonlyMap<string, { additions: number; deletions: number }>;

/** The tree renders in a shadow root; these map it onto the app's theme tokens. */
// SAFETY: React's style type omits custom properties; every value here is a CSS string.
const treeTheme = {
  "--trees-bg-override": "transparent",
  "--trees-fg-override": "var(--foreground)",
  "--trees-fg-muted-override": "var(--muted-foreground)",
  "--trees-bg-muted-override": "var(--muted)",
  "--trees-selected-bg-override": "var(--accent)",
  "--trees-selected-fg-override": "var(--accent-foreground)",
  "--trees-border-color-override": "var(--border)",
  "--trees-search-bg-override": "var(--muted)",
  "--trees-font-family-override": "var(--font-sans)",
  "--trees-font-size-override": "12px",
  "--trees-git-added-color-override": "var(--color-emerald-500)",
  "--trees-git-modified-color-override": "var(--color-amber-500)",
  "--trees-git-deleted-color-override": "var(--color-red-500)",
  "--trees-git-renamed-color-override": "var(--color-sky-500)",
  "--trees-git-untracked-color-override": "var(--color-emerald-500)",
} as React.CSSProperties;

/** A searchable, virtualized path tree. Selecting a file reports its path. */
export function PathTree({
  paths,
  gitStatus,
  counts,
  initialExpansion,
  onSelectFile,
}: {
  paths: readonly string[];
  gitStatus?: readonly GitStatusEntry[];
  counts?: PathCounts;
  initialExpansion: "open" | "closed";
  onSelectFile: (path: string) => void;
}) {
  // The model keeps its options; refs let callbacks see the latest props.
  const countsRef = useRef(counts);
  const selectRef = useRef(onSelectFile);
  countsRef.current = counts;
  selectRef.current = onSelectFile;

  const { model } = useFileTree({
    paths,
    gitStatus,
    initialExpansion,
    flattenEmptyDirectories: true,
    search: true,
    onSelectionChange: (selected) => {
      const path = selected.at(-1);

      if (path && model.getItem(path)?.isDirectory() === false) selectRef.current(path);
    },
    renderRowDecoration: ({ item }) => {
      const count = countsRef.current?.get(item.path);

      if (!count) return null;

      return {
        text: `+${count.additions} -${count.deletions}`,
        parts: [
          { text: `+${count.additions}`, color: "var(--color-emerald-500)" },
          { text: ` -${count.deletions}`, color: "var(--color-red-500)" },
        ],
      };
    },
  });

  useEffect(() => model.resetPaths(paths), [model, paths]);
  useEffect(() => model.setGitStatus(gitStatus), [model, gitStatus]);

  return <FileTree className="h-full" model={model} style={treeTheme} />;
}
