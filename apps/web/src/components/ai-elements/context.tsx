import { createContext, useContext, type ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Progress } from "@/components/ui/progress";
import type { ThreadUsage } from "@/lib/chat-types";
import { cn } from "@/lib/utils";

/**
 * Adapted from the AI Elements Context component. Pi reports exact tokens and
 * cost per call, so this reads them instead of estimating with `tokenlens`.
 */
type ContextSchema = { usage: ThreadUsage; maxTokens: number };

const ContextContext = createContext<ContextSchema | null>(null);

function useContextValue() {
  const context = useContext(ContextContext);

  if (!context) throw new Error("Context components must be used within Context");

  return context;
}

const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });

const compact = new Intl.NumberFormat("en-US", { notation: "compact" });

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function Context({
  usage,
  maxTokens,
  ...props
}: ComponentProps<typeof HoverCard> & ContextSchema) {
  return (
    <ContextContext.Provider value={{ usage, maxTokens }}>
      <HoverCard closeDelay={0} openDelay={0} {...props} />
    </ContextContext.Provider>
  );
}

function ContextIcon({ used }: { used: number }) {
  const circumference = 2 * Math.PI * 10;

  return (
    <svg aria-hidden className="size-4" viewBox="0 0 24 24">
      <circle
        cx="12"
        cy="12"
        fill="none"
        opacity="0.25"
        r="10"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle
        cx="12"
        cy="12"
        fill="none"
        opacity="0.7"
        r="10"
        stroke="currentColor"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={circumference * (1 - Math.min(used, 1))}
        strokeLinecap="round"
        strokeWidth="2"
        style={{ transformOrigin: "center", transform: "rotate(-90deg)" }}
      />
    </svg>
  );
}

export function ContextTrigger({ className, ...props }: ComponentProps<typeof Button>) {
  const { usage, maxTokens } = useContextValue();
  const used = usage.contextTokens / maxTokens;

  return (
    <HoverCardTrigger asChild>
      <Button
        aria-label={`Context ${percent.format(used)} used`}
        className={cn("gap-1.5 text-muted-foreground", className)}
        size="sm"
        type="button"
        variant="ghost"
        {...props}
      >
        <span className="text-xs tabular-nums">{percent.format(used)}</span>
        <ContextIcon used={used} />
      </Button>
    </HoverCardTrigger>
  );
}

function Row({ label, tokens }: { label: string; tokens: number }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{compact.format(tokens)}</span>
    </div>
  );
}

export function ContextContent({ className, ...props }: ComponentProps<typeof HoverCardContent>) {
  const { usage, maxTokens } = useContextValue();
  const used = usage.contextTokens / maxTokens;
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;

  return (
    <HoverCardContent className={cn("min-w-60 divide-y overflow-hidden p-0", className)} {...props}>
      <div className="space-y-2 p-3">
        <div className="flex items-center justify-between gap-3 text-xs">
          <p>{percent.format(used)} of context</p>
          <p className="font-mono text-muted-foreground">
            {compact.format(usage.contextTokens)} / {compact.format(maxTokens)}
          </p>
        </div>
        <Progress className="bg-muted" value={Math.min(used, 1) * 100} />
      </div>
      <div className="space-y-1.5 p-3">
        <Row label="Input" tokens={usage.input} />
        <Row label="Cache read" tokens={usage.cacheRead} />
        <Row label="Cache write" tokens={usage.cacheWrite} />
        <Row label="Output" tokens={usage.output} />
        {prompt > 0 ? (
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Cache hit rate</span>
            <span className="font-mono">{percent.format(usage.cacheRead / prompt)}</span>
          </div>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-3 bg-secondary p-3 text-xs">
        <span className="text-muted-foreground">Total cost</span>
        <span>{usd.format(usage.cost)}</span>
      </div>
    </HoverCardContent>
  );
}
