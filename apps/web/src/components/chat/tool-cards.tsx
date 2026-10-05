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
  SearchIcon,
  TerminalIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { commandOutput, safeWebUrl, type ToolGroup } from "@/lib/tool-presentation";
import { Markdown } from "./markdown";
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

const searchArgsSchema = z.looseObject({ query: z.string() });

const fetchArgsSchema = z.looseObject({ url: z.string() });

export function ToolCard({ part }: { part: ProjectedToolPart }) {
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

  if (structured?.kind === "search")
    return {
      icon: <SearchIcon className="size-3.5" />,
      title: `Search ${structured.query}`,
      detail: `${structured.results.length} result${structured.results.length === 1 ? "" : "s"}${
        structured.partial ? " (partial)" : ""
      }`,
      body:
        structured.results.length === 0 ? (
          <Notice>{structured.status === "ok" ? "No results." : "The search failed."}</Notice>
        ) : (
          <div className="flex flex-col gap-2">
            {structured.partial ? <Notice>Partial search results.</Notice> : null}
            {structured.status !== "ok" ? (
              <Notice>Search status: {structured.status}</Notice>
            ) : null}
            <ol className="flex flex-col gap-3">
              {structured.results.map((result, index) => (
                <li className="flex min-w-0 flex-col gap-0.5" key={`${index}:${result.url}`}>
                  <a
                    className="truncate text-sm font-medium underline-offset-3 hover:underline"
                    href={safeWebUrl(result.url)}
                    rel="noreferrer noopener"
                    target="_blank"
                  >
                    {result.title}
                  </a>
                  <Hostname url={result.url} />
                  {(result.snippet ?? result.excerpt) ? (
                    <p className="text-xs text-muted-foreground">
                      {result.snippet ?? result.excerpt}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        ),
    };

  if (structured?.kind === "fetch") {
    const host = structured.finalUrl ?? structured.requestedUrl;

    return {
      icon: <GlobeIcon className="size-3.5" />,
      title: `Fetch ${hostnameOf(host)}`,
      detail: structured.contentType,
      body: (
        <div className="flex flex-col gap-2">
          <Hostname url={host} />
          {structured.title ? <p className="text-sm font-medium">{structured.title}</p> : null}
          {structured.content ? (
            <div className="max-h-96 min-w-0 overflow-auto">
              <Markdown>{structured.content}</Markdown>
            </div>
          ) : null}
          {structured.truncated ? <Notice>The page was truncated.</Notice> : null}
          {structured.status !== "ok" ? <Notice>Fetch status: {structured.status}</Notice> : null}
        </div>
      ),
    };
  }

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

  if (part.name === "web_search" || part.name === "web_fetch") {
    const parsed = (part.name === "web_search" ? searchArgsSchema : fetchArgsSchema).safeParse(
      args,
    );

    return {
      icon:
        part.name === "web_search" ? (
          <SearchIcon className="size-3.5" />
        ) : (
          <GlobeIcon className="size-3.5" />
        ),
      title: parsed.success
        ? `${toolLabel(part.name)} ${"query" in parsed.data ? parsed.data.query : parsed.data.url}`
        : toolLabel(part.name),
      detail: null,
      body: commandOutput(part).text ? <OutputBlock text={commandOutput(part).text} /> : null,
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
    case "web_search":
      return "Search";
    case "web_fetch":
      return "Fetch";
    default:
      return name;
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function Hostname({ url }: { url: string }) {
  const hostname = hostnameOf(url);

  // Never render a scheme other than http(s) as a link.
  if (!safeWebUrl(url))
    return <span className="truncate text-xs text-muted-foreground">{hostname}</span>;

  return (
    <a
      className="truncate text-xs text-muted-foreground underline-offset-3 hover:underline"
      href={safeWebUrl(url)}
      rel="noreferrer noopener"
      target="_blank"
    >
      {hostname}
    </a>
  );
}
