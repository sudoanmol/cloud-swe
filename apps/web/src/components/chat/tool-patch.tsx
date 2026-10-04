import { useMemo } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import { PatchDiff } from "@pierre/diffs/react";

export default function ToolPatch({ patch, truncated }: { patch: string; truncated: boolean }) {
  const valid = useMemo(() => {
    if (truncated) return false;

    try {
      const parsed = parsePatchFiles(patch, undefined, true);

      return parsed.length === 1 && parsed[0]?.files.length === 1;
    } catch {
      return false;
    }
  }, [patch, truncated]);

  if (!valid)
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          {truncated
            ? "Truncated diff. Showing available text."
            : "Invalid diff. Showing available text."}
        </p>
        <pre className="max-h-96 overflow-auto rounded-lg bg-muted/50 p-3 text-xs">{patch}</pre>
      </div>
    );

  return (
    <div className="max-h-96 overflow-auto rounded-lg border border-border/60">
      <PatchDiff
        options={{
          diffStyle: "unified",
          overflow: "scroll",
          theme: { dark: "github-dark", light: "github-light" },
        }}
        patch={patch}
      />
    </div>
  );
}
