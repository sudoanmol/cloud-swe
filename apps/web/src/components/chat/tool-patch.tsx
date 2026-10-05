import { useMemo } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import { File, MultiFileDiff, PatchDiff } from "@pierre/diffs/react";

export const codeTheme = { dark: "github-dark", light: "github-light" } as const;

const frame = "max-h-96 overflow-auto rounded-lg border border-border/60";

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
    <div className={frame}>
      <PatchDiff
        options={{ diffStyle: "unified", overflow: "scroll", theme: codeTheme }}
        patch={patch}
      />
    </div>
  );
}

/** A created file, shown as an all-additions diff. */
export function ToolCreatedFile({ path, contents }: { path: string; contents: string }) {
  return (
    <div className={frame}>
      <MultiFileDiff
        newFile={{ name: path, contents }}
        oldFile={{ name: path, contents: "" }}
        options={{ diffStyle: "unified", overflow: "scroll", theme: codeTheme }}
      />
    </div>
  );
}

/** Syntax-highlighted file text; the language comes from the file name. */
export function ToolFile({
  path,
  contents,
  lineNumbers = true,
}: {
  path: string;
  contents: string;
  lineNumbers?: boolean;
}) {
  return (
    <div className={frame}>
      <File
        file={{ name: path, contents }}
        options={{
          disableFileHeader: true,
          disableLineNumbers: !lineNumbers,
          overflow: "scroll",
          theme: codeTheme,
        }}
      />
    </div>
  );
}
