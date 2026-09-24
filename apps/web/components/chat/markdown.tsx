"use client";

import { Streamdown, type Components } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";

import { cn } from "@/lib/utils";
import { safeWebUrl } from "@/lib/tool-presentation";

const plugins = { cjk, code, math, mermaid };

const components: Components = {
  a: ({ href, children }) => {
    const safe = href ? safeWebUrl(href) : undefined;

    return safe ? (
      <a href={safe} rel="noopener noreferrer" target="_blank">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
  // Fetched and assistant content must not trigger requests to arbitrary hosts.
  img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : "[Image omitted]"}</span>,
};

export function Markdown({
  children,
  className,
  streaming,
}: {
  children: string;
  className?: string;
  streaming?: boolean;
}) {
  return (
    <Streamdown
      className={cn(
        "size-full text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        streaming &&
          "after:ml-0.5 after:inline-block after:h-4 after:w-1.5 after:animate-pulse after:bg-foreground/60 after:align-text-bottom after:content-['']",
        className,
      )}
      components={components}
      isAnimating={streaming ?? false}
      mode={streaming ? "streaming" : "static"}
      mermaid={{ config: { securityLevel: "strict" } }}
      plugins={plugins}
      skipHtml
      urlTransform={(url) => safeWebUrl(url) ?? ""}
    >
      {children}
    </Streamdown>
  );
}
