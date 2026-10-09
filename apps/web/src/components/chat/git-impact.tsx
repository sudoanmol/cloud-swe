import { ArrowRightIcon, CircleCheckIcon, GitBranchIcon, TriangleAlertIcon } from "lucide-react";
import type { GitPrImpact, GitPushImpact } from "@cloud-swe/db/git-contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function Branch({ label, name }: { label: string; name: string }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[11px] text-muted-foreground uppercase">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 font-mono text-xs">
        <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate" title={name}>
          {name}
        </span>
      </span>
    </span>
  );
}

/** Two branches and the direction changes move between them. */
export function BranchFlow(props: {
  from: string;
  fromLabel: string;
  to: string;
  toLabel: string;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Branch label={props.fromLabel} name={props.from} />
      <ArrowRightIcon aria-hidden className="mb-1.5 size-4 shrink-0 text-muted-foreground" />
      <Branch label={props.toLabel} name={props.to} />
    </div>
  );
}

function Counts({
  files,
  additions,
  deletions,
}: Pick<GitPushImpact, "files" | "additions" | "deletions">) {
  return (
    <span className="tabular-nums">
      {plural(files, "file")} changed,{" "}
      <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>{" "}
      <span className="text-red-600 dark:text-red-400">−{deletions}</span>
    </span>
  );
}

export function PushImpactView({
  impact,
  changedFiles,
}: {
  impact: GitPushImpact;
  /** Uncommitted files a manual push commits first. */
  changedFiles?: number;
}) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <BranchFlow
        from={impact.branch}
        fromLabel="Workspace"
        to={impact.branch}
        toLabel={impact.newBranch ? "New on GitHub" : "GitHub"}
      />
      <ul className="flex list-disc flex-col gap-1 pl-5">
        {changedFiles ? (
          <li>
            Commit {plural(changedFiles, "uncommitted file")} on {impact.branch}.
          </li>
        ) : null}
        <li>
          {impact.newBranch
            ? `Create ${impact.branch} on GitHub with ${plural(impact.commits, "commit")}`
            : `Add ${plural(impact.commits, "commit")} to ${impact.branch}`}
          {impact.compareBranch ? ` (compared with ${impact.compareBranch})` : ""}:{" "}
          <Counts {...impact} />.
        </li>
      </ul>
      {impact.nonFastForward ? (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>
            Force push replaces {plural(impact.overwrittenCommits, "commit")} on GitHub
          </AlertTitle>
          <AlertDescription>
            GitHub&apos;s {impact.branch} has {plural(impact.overwrittenCommits, "commit")} that the
            workspace does not. Pushing replaces the remote branch with the workspace&apos;s, so
            those commits disappear from it. This happens when someone else pushed to the branch or
            it was rebased elsewhere. To keep them, pull them into the workspace first.
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

export function PrImpactView({ impact }: { impact: GitPrImpact }) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <BranchFlow from={impact.head} fromLabel="Merge" to={impact.base} toLabel="Into" />
      <p>
        {plural(impact.commits, "commit")}: <Counts {...impact} />.
        {impact.behind ? (
          <span className="text-muted-foreground">
            {" "}
            {impact.base} has {plural(impact.behind, "newer commit")} that {impact.head} does not.
          </span>
        ) : null}
      </p>
      {impact.conflicts.length ? (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>
            {plural(impact.conflicts.length, "file")} conflict with {impact.base}
          </AlertTitle>
          <AlertDescription>
            <ul className="mt-1 flex flex-col gap-0.5 font-mono text-xs">
              {impact.conflicts.map((path) => (
                <li className="break-all" key={path}>
                  {path}
                </li>
              ))}
              {impact.conflictsTruncated ? <li>…and more</li> : null}
            </ul>
          </AlertDescription>
        </Alert>
      ) : (
        <p className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
          <CircleCheckIcon className="size-4 shrink-0" />
          No conflicts. GitHub can merge this automatically.
        </p>
      )}
    </div>
  );
}
