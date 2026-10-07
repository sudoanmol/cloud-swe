import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { useAccountGuard } from "@/lib/account-scope";
import { connectToolMutation, toolsQueryOptions } from "@/lib/queries";

export function ToolsStep({
  userId,
  returnTo,
  onSkip,
  skipDisabled,
}: {
  userId: string;
  returnTo: "/onboarding" | "/settings";
  onSkip?: () => void;
  skipDisabled?: boolean;
}) {
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string>();
  const tools = useQuery(toolsQueryOptions(userId, search, cursor));
  const guardAccount = useAccountGuard();

  const connect = useMutation({
    ...connectToolMutation(),
    onSuccess: (result) => {
      if (guardAccount(userId)) window.location.assign(result.redirectUrl);
    },
  });

  if (tools.data?.enabled === false) return null;
  const recommended = tools.data?.recommended ?? [];
  const items = search ? (tools.data?.items ?? []) : [];

  function rows(toolkits: typeof recommended) {
    return toolkits.map((toolkit) => (
      <li className="flex items-center justify-between gap-3" key={toolkit.slug}>
        <span className="text-sm">{toolkit.name}</span>
        <Button
          disabled={connect.isPending || toolkit.connected}
          onClick={() => connect.mutate({ toolkit: toolkit.slug, returnTo })}
          size="sm"
          variant="outline"
          type="button"
        >
          {toolkit.connected ? "Connected" : "Connect"}
        </Button>
      </li>
    ));
  }

  return (
    <section className="flex flex-col gap-4" aria-label="Tools">
      <header>
        <h2 className="font-medium text-base">Tools</h2>
        <p className="text-muted-foreground text-sm">
          Connect Firecrawl for web research and Context7 for library documentation. You can add
          more tools now or in Settings.
        </p>
      </header>
      <ul className="flex flex-col gap-3">{rows(recommended)}</ul>
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(input.trim());
          setCursor(undefined);
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`toolkit-search-${returnTo.slice(1)}`}>Find more tools</FieldLabel>
            <Input
              id={`toolkit-search-${returnTo.slice(1)}`}
              value={input}
              maxLength={100}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Search Composio toolkits"
            />
          </Field>
        </FieldGroup>
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      {tools.isPending ? <p className="text-sm text-muted-foreground">Loading tools…</p> : null}
      {search ? <ul className="flex flex-col gap-3">{rows(items)}</ul> : null}
      {search && !tools.isFetching && items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tools found.</p>
      ) : null}
      {search && tools.data?.cursor ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => setCursor(tools.data?.cursor ?? undefined)}
        >
          Next results
        </Button>
      ) : null}
      {tools.isError || connect.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Tools could not be loaded or connected.{" "}
          <Button type="button" variant="link" onClick={() => void tools.refetch()}>
            Retry
          </Button>
        </p>
      ) : null}
      {onSkip ? (
        <Button type="button" variant="ghost" onClick={onSkip} disabled={skipDisabled}>
          Skip tools
        </Button>
      ) : null}
    </section>
  );
}
