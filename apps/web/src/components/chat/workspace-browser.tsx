import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import type { ThreadProjection } from "@/lib/chat-types";
import { ExternalLinkIcon } from "lucide-react";

import { Spinner } from "@/components/ui/spinner";
import {
  browserQueryOptions,
  browserControlMutation,
  questionsQueryOptions,
  workspacePreviewsQueryOptions,
} from "@/lib/queries";
import { messageForError } from "@/lib/submission-errors";
import { safeWebUrl } from "@/lib/tool-presentation";

function Previews({ userId, threadId, live }: { userId: string; threadId: string; live: boolean }) {
  const previews = useQuery({ ...workspacePreviewsQueryOptions(userId, threadId), enabled: live });

  if (previews.isError)
    return <p className="text-sm text-destructive">{messageForError(previews.error)}</p>;

  if (previews.isPending)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-3.5" /> Looking for servers
      </p>
    );

  const ports = previews.data.ports.flatMap(({ port, url }) => {
    const safe = safeWebUrl(url);

    return safe ? [{ port, url: safe }] : [];
  });

  if (ports.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No servers are listening. Ports appear here when the agent starts one.
      </p>
    );

  return (
    <ul className="flex flex-col gap-1">
      {ports.map(({ port, url }) => (
        <li key={port}>
          <a
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
            href={url}
            rel="noreferrer"
            target="_blank"
          >
            <span className="w-14 shrink-0 font-mono tabular-nums">{port}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{url}</span>
            <ExternalLinkIcon className="size-3.5 shrink-0" />
          </a>
        </li>
      ))}
    </ul>
  );
}

function HostedBrowser({
  userId,
  threadId,
  live,
  browser,
}: {
  userId: string;
  threadId: string;
  live: boolean;
  browser: ThreadProjection["browser"];
}) {
  const client = useQueryClient();
  const query = useQuery({ ...browserQueryOptions(userId, threadId), enabled: live });

  const control = useMutation({
    ...browserControlMutation(threadId),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: browserQueryOptions(userId, threadId).queryKey }),
        client.invalidateQueries({ queryKey: questionsQueryOptions(userId, threadId).queryKey }),
      ]);
    },
  });

  const iframe = useRef<HTMLIFrameElement>(null);
  const url = query.data?.liveViewUrl ? safeWebUrl(query.data.liveViewUrl) : undefined;
  // Ownership changes arrive over SSE, including handoffs published by the runner.
  const owner = browser.owner;

  const setReadOnly = () => {
    if (url)
      iframe.current?.contentWindow?.postMessage(
        { type: "KERNEL_SET_READ_ONLY", readOnly: owner !== "user" },
        new URL(url).origin,
      );
  };

  useEffect(() => {
    if (!url) return;
    const origin = new URL(url).origin;

    const update = () =>
      iframe.current?.contentWindow?.postMessage(
        { type: "KERNEL_SET_READ_ONLY", readOnly: owner !== "user" },
        origin,
      );

    const connected = (event: MessageEvent) => {
      if (
        event.origin === origin &&
        event.source === iframe.current?.contentWindow &&
        event.data?.type === "KERNEL_CONNECTED"
      )
        update();
    };

    update();
    window.addEventListener("message", connected);

    return () => window.removeEventListener("message", connected);
  }, [owner, url]);

  if (query.isError)
    return <p className="text-sm text-destructive">{messageForError(query.error)}</p>;

  if (!live)
    return (
      <p className="text-sm text-muted-foreground">Resume the workspace to use its browser.</p>
    );

  if (query.isPending) return <Spinner className="size-4" />;

  if (!url)
    return (
      <p className="text-sm text-muted-foreground">
        The live view appears when the agent opens its browser.
      </p>
    );
  const source = new URL(url);
  source.searchParams.set("readOnly", "true");

  return (
    <section className="flex min-h-80 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm">
          {owner === "user"
            ? "You control the browser"
            : browser.active
              ? "Agent is browsing"
              : "Agent browser"}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={control.isPending}
          onClick={() => control.mutate(owner === "user" ? "agent" : "user")}
        >
          {control.isPending ? <Spinner /> : null}
          {owner === "user" ? "Hand back" : "Take control"}
        </Button>
      </div>
      {control.isError ? (
        <p className="text-sm text-destructive">{messageForError(control.error)}</p>
      ) : null}
      <iframe
        ref={iframe}
        title="Agent browser"
        className="min-h-72 w-full flex-1 rounded-md border"
        src={source.href}
        onLoad={setReadOnly}
        allow="autoplay; clipboard-read; clipboard-write"
        referrerPolicy="origin"
      />
    </section>
  );
}

export function WorkspaceBrowser({
  userId,
  threadId,
  live,
  browser,
  features,
}: {
  userId: string;
  threadId: string;
  live: boolean;
  browser: ThreadProjection["browser"];
  features: { browser: boolean; previews: boolean };
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      {features.browser ? (
        <HostedBrowser userId={userId} threadId={threadId} live={live} browser={browser} />
      ) : null}
      {features.previews ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium text-muted-foreground uppercase">Previews</h2>
          {live ? (
            <Previews live={live} threadId={threadId} userId={userId} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Previews work while the workspace is running.
            </p>
          )}
        </section>
      ) : null}
    </div>
  );
}
