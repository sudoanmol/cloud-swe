import { ClientOnly } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";
import { z } from "zod";
import {
  AlertTriangleIcon,
  ChevronRightIcon,
  FileCodeIcon,
  FilePlusIcon,
  FileTextIcon,
  GlobeIcon,
  TerminalIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { commandOutput, type ToolGroup } from "@/lib/tool-presentation";
import type { ProjectedToolPart } from "@/lib/chat-types";
import { cn } from "@/lib/utils";

// The diff and highlighting renderers are browser-only and loaded on first use.
const LazyToolPatch = lazy(() => import("./tool-patch"));

const LazyToolCreatedFile = lazy(() =>
  import("./tool-patch").then((module) => ({ default: module.ToolCreatedFile })),
);

const LazyToolFile = lazy(() =>
  import("./tool-patch").then((module) => ({ default: module.ToolFile })),
);

function ClientCode({ children }: { children: React.ReactNode }) {
  const fallback = <Skeleton className="h-24 rounded-lg" />;

  return (
    <ClientOnly fallback={fallback}>
      <Suspense fallback={fallback}>{children}</Suspense>
    </ClientOnly>
  );
}

function ToolPatch(props: { patch: string; truncated: boolean }) {
  return (
    <ClientCode>
      <LazyToolPatch {...props} />
    </ClientCode>
  );
}

/** Pi's read tool appends a bracketed continuation notice after the file text. */
const readNoticePattern =
  /\n\n(\[(?:Showing lines \d+-\d+ of \d+|\d+ more lines in file)[^\]]*\])$/;

function splitReadOutput(text: string): { contents: string; notice: string | null } {
  const match = readNoticePattern.exec(text);

  return match
    ? { contents: text.slice(0, match.index), notice: match[1] ?? null }
    : { contents: text, notice: null };
}

export function ToolGroupCard({ group }: { group: ToolGroup }) {
  const titles = [...new Set(group.parts.map((part) => describeTool(part).title))];

  return (
    <section aria-label={group.label} className="flex min-w-0 flex-col gap-2">
      <p className="truncate text-xs text-muted-foreground" title={titles.join(", ")}>
        {group.label} · {group.parts.length} {group.parts.length === 1 ? "call" : "calls"}
      </p>
      {group.parts.map((part) => (
        <ToolCard key={part.key} part={part} />
      ))}
    </section>
  );
}

/**
 * `tool.started` args are untrusted beyond `unknown`; the fields a card needs
 * are parsed here so a surprising argument shape degrades to the tool name
 * instead of breaking the transcript.
 */
const bashArgsSchema = z.looseObject({ command: z.string() });

const pathArgsSchema = z.looseObject({ path: z.string() });

const readArgsSchema = z.looseObject({ path: z.string(), offset: z.number().optional() });

export function ToolCard({ part }: { part: ProjectedToolPart }) {
  if (part.name.startsWith("mcp__")) return <McpToolCard part={part} />;

  return <WorkspaceToolCard part={part} />;
}

function WorkspaceToolCard({ part }: { part: ProjectedToolPart }) {
  const view = describeTool(part);
  const [open, setOpen] = useState(false);

  return (
    <Collapsible
      className="w-full min-w-0 rounded-xl border border-border/60 bg-card/40"
      id={`tool-${part.key}`}
      onOpenChange={setOpen}
      open={open}
    >
      <CollapsibleTrigger
        className="flex w-full min-w-0 items-center gap-2.5 px-3.5 py-2.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        disabled={view.body === null}
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
            view.body === null && "opacity-0",
          )}
        />
        <span className="shrink-0 text-muted-foreground">{view.icon}</span>
        <span className="min-w-0 truncate font-medium" title={view.title}>
          {view.title}
        </span>
        {view.detail ? (
          <span
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            title={view.detail}
          >
            {view.detail}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <StatusBadge part={part} />
      </CollapsibleTrigger>
      {part.state === "failed" ? (
        <p className="px-3.5 pb-2.5 text-xs break-words text-destructive">
          {part.diagnostic ?? (commandOutput(part).text.slice(0, 500) || "The tool failed.")}
        </p>
      ) : null}
      {view.body && open ? (
        <CollapsibleContent className="flex flex-col gap-2 border-t border-border/60 px-3.5 py-3">
          {view.body}
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}

function StatusBadge({ part }: { part: ProjectedToolPart }) {
  if (part.state === "running")
    return (
      <Badge className="gap-1.5" variant="secondary">
        <Spinner className="size-3" />
        Running
      </Badge>
    );

  if (part.state === "failed")
    return (
      <Badge className="gap-1.5" variant="destructive">
        <AlertTriangleIcon className="size-3" />
        Failed
      </Badge>
    );

  return (
    <Badge variant="secondary">
      {part.legacy?.statusCode != null ? `Exit ${part.legacy.statusCode}` : "Done"}
    </Badge>
  );
}

function OutputBlock({ text, tone }: { text: string; tone?: "error" }) {
  return (
    <pre
      className={cn(
        "max-h-80 overflow-auto rounded-lg bg-muted/50 p-3 text-xs leading-relaxed break-words whitespace-pre-wrap",
        tone === "error" && "text-destructive",
      )}
    >
      {text}
    </pre>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

type ToolView = {
  icon: React.ReactNode;
  title: string;
  detail: string | null;
  body: React.ReactNode;
};

function describeTool(part: ProjectedToolPart): ToolView {
  const structured = part.structured;

  if (part.name === "request_browser_handoff")
    return {
      icon: <GlobeIcon className="size-3.5" />,
      title: "Hand browser to user",
      detail: null,
      body: null,
    };

  if (structured?.kind === "edit" && part.state !== "failed")
    return {
      icon: <FileCodeIcon className="size-3.5" />,
      title: `Edit ${structured.path}`,
      detail: `+${structured.additions} −${structured.deletions}`,
      body: <ToolPatch patch={structured.unifiedDiff} truncated={structured.diffTruncated} />,
    };

  if (structured?.kind === "write" && part.state !== "failed")
    return {
      icon: <FilePlusIcon className="size-3.5" />,
      title: `${structured.change === "created" ? "Create" : "Write"} ${structured.path}`,
      detail: `${structured.bytes} bytes`,
      body: structured.preview ? (
        <div className="flex flex-col gap-2">
          {structured.change === "created" ? (
            <ClientCode>
              <LazyToolCreatedFile contents={structured.preview} path={structured.path} />
            </ClientCode>
          ) : (
            <ClientCode>
              <LazyToolFile contents={structured.preview} path={structured.path} />
            </ClientCode>
          )}
          {structured.previewTruncated ? (
            <Notice>Only the start of the file is shown.</Notice>
          ) : null}
        </div>
      ) : null,
    };

  if (structured?.kind === "read")
    return {
      icon: <FileTextIcon className="size-3.5" />,
      title: `Read ${structured.path}`,
      detail: structured.outputTruncated ? "truncated" : null,
      body: null,
    };

  const args = part.args;

  if (part.name === "bash") {
    const command = bashArgsSchema.safeParse(args);
    const output = commandOutput(part);

    return {
      icon: <TerminalIcon className="size-3.5" />,
      title: "Bash",
      detail: command.success ? command.data.command : null,
      body:
        output.text || part.diagnostic ? (
          <div className="flex flex-col gap-2">
            {output.text ? (
              <OutputBlock
                text={output.text}
                tone={part.legacy?.kind === "nonzero" ? "error" : undefined}
              />
            ) : null}
            {output.truncated ? <Notice>The output was truncated.</Notice> : null}
            {part.diagnostic ? <Notice>{part.diagnostic}</Notice> : null}
          </div>
        ) : null,
    };
  }

  if (part.name === "read" && part.state === "completed" && commandOutput(part).text) {
    const parsed = readArgsSchema.safeParse(args);
    const path = parsed.success ? parsed.data.path : "file";
    const output = commandOutput(part);
    const { contents, notice } = splitReadOutput(output.text);
    // The viewer numbers from 1, so an excerpt from later in the file hides numbers.
    const fromStart = !parsed.success || (parsed.data.offset ?? 1) <= 1;

    return {
      icon: <FileTextIcon className="size-3.5" />,
      title: `${toolLabel(part.name)} ${path}`,
      detail: null,
      body: (
        <div className="flex flex-col gap-2">
          <ClientCode>
            <LazyToolFile contents={contents} lineNumbers={fromStart} path={path} />
          </ClientCode>
          {notice ? <Notice>{notice.slice(1, -1)}</Notice> : null}
          {output.truncated ? <Notice>The output was truncated.</Notice> : null}
        </div>
      ),
    };
  }

  if (part.name === "edit" || part.name === "read" || part.name === "write") {
    const parsed = pathArgsSchema.safeParse(args);

    return {
      icon: <FileTextIcon className="size-3.5" />,
      title: parsed.success ? `${toolLabel(part.name)} ${parsed.data.path}` : toolLabel(part.name),
      detail: null,
      body:
        part.name !== "read" && commandOutput(part).text ? (
          <OutputBlock text={commandOutput(part).text} />
        ) : null,
    };
  }

  return {
    icon: <TerminalIcon className="size-3.5" />,
    title: part.name,
    detail: null,
    body: commandOutput(part).text ? <OutputBlock text={commandOutput(part).text} /> : null,
  };
}

function toolLabel(name: string): string {
  switch (name) {
    case "edit":
      return "Edit";
    case "read":
      return "Read";
    case "write":
      return "Write";
    default:
      return name;
  }
}

export function McpToolCard({ part }: { part: ProjectedToolPart }) {
  const result = part.structured?.kind === "mcp" ? part.structured : null;
  const [, server, ...tool] = part.name.split("__");

  return (
    <div
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card/40 p-3.5"
      id={`tool-${part.key}`}
    >
      <header className="flex min-w-0 items-center gap-2 text-sm">
        <GlobeIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 break-words font-medium">
          {result?.server ?? server} / {result?.tool ?? tool.join("__")}
        </span>
        <StatusBadge part={part} />
      </header>
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">Arguments</summary>
        <OutputBlock text={JSON.stringify(part.args, null, 2) ?? "{}"} />
      </details>
      {result ? (
        result.content.map((block, index) =>
          block.type === "text" ? (
            <OutputBlock key={index} text={block.text} />
          ) : (
            <img
              key={index}
              className="max-h-80 max-w-full object-contain"
              alt={`${result.tool} result ${index + 1}`}
              src={`data:${block.mimeType};base64,${block.data}`}
            />
          ),
        )
      ) : commandOutput(part).text ? (
        <OutputBlock text={commandOutput(part).text} />
      ) : null}
      {result?.truncated ? <Notice>The output was truncated.</Notice> : null}
      {part.state === "failed" ? (
        <p role="alert" className="text-xs text-destructive">
          {part.diagnostic || "The MCP tool failed."}
        </p>
      ) : null}
    </div>
  );
}
