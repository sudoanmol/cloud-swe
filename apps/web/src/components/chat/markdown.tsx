import { lazy, Suspense } from "react";

import { cn } from "@/lib/utils";

// The renderer carries code highlighting, math, and diagrams; show the raw text
// until it loads so first paint never waits on it.
const RichMarkdown = lazy(() => import("./rich-markdown"));

export function Markdown(props: { children: string; className?: string; streaming?: boolean }) {
  return (
    <Suspense
      fallback={
        <div className={cn("text-sm leading-relaxed whitespace-pre-wrap", props.className)}>
          {props.children}
        </div>
      }
    >
      <RichMarkdown {...props} />
    </Suspense>
  );
}
