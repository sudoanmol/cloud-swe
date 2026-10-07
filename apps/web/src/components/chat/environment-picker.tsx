import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ThreadSnapshot } from "@cloud-swe/api/contracts";
import { Link } from "@tanstack/react-router";
import { KeyRoundIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  environmentsQueryOptions,
  setThreadEnvironmentMutation,
  threadQueryOptions,
} from "@/lib/queries";

const NONE = "none";

/** Choose the environment whose variables every command in the next run receives. */
export function EnvironmentPicker({
  userId,
  value,
  onChange,
  disabled,
  label,
}: {
  userId: string;
  value: string | null;
  onChange: (environmentId: string | null) => void;
  disabled?: boolean;
  /** Overrides the trigger text, for example a deleted environment's state. */
  label?: string;
}) {
  const environments = useQuery(environmentsQueryOptions(userId));
  const selected = environments.data?.find((environment) => environment.id === value);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Environment"
          className="h-7 min-w-0 gap-1.5 rounded-lg px-2 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          disabled={disabled}
          type="button"
          variant="ghost"
        >
          <KeyRoundIcon className="size-3.5 shrink-0" />
          <span className="truncate">{label ?? selected?.name ?? "No environment"}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-w-72 rounded-xl border border-border/60 bg-card/95 shadow-[var(--shadow-float)] backdrop-blur-xl"
        sideOffset={8}
      >
        <DropdownMenuRadioGroup
          onValueChange={(next) => onChange(next === NONE ? null : next)}
          value={value ?? NONE}
        >
          <DropdownMenuRadioItem className="text-[13px]" value={NONE}>
            No environment
          </DropdownMenuRadioItem>
          {environments.data?.map((environment) => (
            <DropdownMenuRadioItem
              className="text-[13px]"
              key={environment.id}
              value={environment.id}
            >
              <span className="truncate">{environment.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className="text-[13px]">
          <Link to="/settings">Manage environments</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Thread header: the pinned revision, with "Update to latest" when the environment changed. */
export function ThreadEnvironment({
  userId,
  threadId,
  environment,
}: {
  userId: string;
  threadId: string;
  environment: ThreadSnapshot["environment"];
}) {
  const queryClient = useQueryClient();

  const change = useMutation({
    ...setThreadEnvironmentMutation(),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: threadQueryOptions(userId, threadId).queryKey }),
  });

  const set = (environmentId: string | null) => change.mutate({ threadId, environmentId });

  return (
    <div className="flex min-w-0 items-center gap-1">
      <span
        className="min-w-0"
        title={
          environment
            ? `Revision ${environment.revisionNumber}, saved ${new Date(environment.revisionCreatedAt).toLocaleString()}. Changes apply to the next run.`
            : "Changes apply to the next run."
        }
      >
        <EnvironmentPicker
          disabled={change.isPending}
          label={
            environment
              ? `${environment.name} · rev ${environment.revisionNumber}`
              : "No environment"
          }
          onChange={set}
          userId={userId}
          value={environment?.id ?? null}
        />
      </span>
      {environment && environment.latestRevisionNumber > environment.revisionNumber ? (
        <Button
          className="h-7 rounded-lg px-2 text-[12px]"
          disabled={change.isPending}
          onClick={() => set(environment.id)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Update to latest
        </Button>
      ) : null}
    </div>
  );
}
