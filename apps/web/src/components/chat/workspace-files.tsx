import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { File } from "@pierre/diffs/react";

import { Spinner } from "@/components/ui/spinner";
import { workspaceFileQueryOptions, workspaceFilesQueryOptions } from "@/lib/queries";
import { messageForError } from "@/lib/submission-errors";
import { codeTheme } from "./tool-patch";
import { PathTree } from "./path-tree";

function FileContents({
  userId,
  threadId,
  path,
  live,
}: {
  userId: string;
  threadId: string;
  path: string;
  live: boolean;
}) {
  const file = useQuery({ ...workspaceFileQueryOptions(userId, threadId, path), enabled: live });

  if (file.isError)
    return <p className="p-4 text-sm text-destructive">{messageForError(file.error)}</p>;

  if (file.isPending)
    return (
      <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Spinner className="size-3.5" /> Loading {path}
      </p>
    );

  if (file.data.kind !== "text")
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {file.data.kind === "binary" ? "Binary file." : "File is larger than 1 MiB."}
      </p>
    );

  return (
    <File
      file={{ name: path, contents: file.data.contents }}
      options={{ overflow: "scroll", stickyHeader: true, theme: codeTheme }}
    />
  );
}

export function WorkspaceFiles({
  userId,
  threadId,
  live,
}: {
  userId: string;
  threadId: string;
  /** False while the workspace is paused: cached results stay visible. */
  live: boolean;
}) {
  const files = useQuery({ ...workspaceFilesQueryOptions(userId, threadId), enabled: live });
  const [selected, setSelected] = useState<string | null>(null);

  if (files.isError)
    return <p className="p-4 text-sm text-destructive">{messageForError(files.error)}</p>;

  if (files.isPending)
    return (
      <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Spinner className="size-3.5" /> Loading files
      </p>
    );

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-64 shrink-0 flex-col border-r border-border/60">
        <div className="min-h-0 flex-1">
          <PathTree initialExpansion="closed" onSelectFile={setSelected} paths={files.data.paths} />
        </div>
        {files.data.truncated ? (
          <p className="border-t border-border/60 p-2 text-xs text-muted-foreground">
            Showing the first {files.data.paths.length.toLocaleString()} files.
          </p>
        ) : null}
      </div>
      <div className="min-w-0 flex-1 overflow-auto">
        {selected ? (
          <FileContents
            key={selected}
            live={live}
            path={selected}
            threadId={threadId}
            userId={userId}
          />
        ) : (
          <p className="p-4 text-sm text-muted-foreground">Select a file to view it.</p>
        )}
      </div>
    </div>
  );
}
