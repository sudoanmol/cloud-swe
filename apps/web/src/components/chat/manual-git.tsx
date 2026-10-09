import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpFromLineIcon,
  ChevronDownIcon,
  GitBranchIcon,
  GitPullRequestCreateArrowIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { ManualGitCheck } from "@cloud-swe/db/manual-git";
import {
  manualGitCheckMutation,
  manualGitConfirmMutation,
  manualGitRunQueryOptions,
  manualGitStatusQueryOptions,
} from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupSeparator } from "@/components/ui/button-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { plural, PrImpactView, PushImpactView } from "./git-impact";

type Action = "push" | "pr";

/**
 * Header Push and Open PR. Shown only when the sandbox has something to push
 * or a branch without an open PR. Opening the dialog checks in the background
 * what the action would do; confirming is the approval. The last check per
 * action is reused until the user checks again or confirms; confirmation still
 * verifies the workspace and GitHub have not moved since.
 */
export function ManualGit({
  userId,
  threadId,
  running,
  onAskAgent,
}: {
  userId: string;
  threadId: string;
  running: boolean;
  onAskAgent: (prompt: string) => void;
}) {
  const [action, setAction] = useState<Action | null>(null);
  // ponytail: in-memory per page load; a reload checks again.
  const [checks, setChecks] = useState<Record<string, string | null>>({});
  const status = useQuery(manualGitStatusQueryOptions(userId, threadId));
  const client = useQueryClient();

  if (!status.data?.branch) return null;
  const disabled = running || !status.data.available;

  const close = () => {
    setAction(null);
    void client.invalidateQueries({ queryKey: ["session", userId, "thread", threadId] });
  };

  return (
    <>
      {status.data.push ? (
        <Button
          className="hidden gap-1.5 sm:inline-flex"
          disabled={disabled}
          onClick={() => setAction("push")}
          size="sm"
        >
          <ArrowUpFromLineIcon className="size-4" />
          Push
        </Button>
      ) : null}
      {status.data.pr ? (
        <Button
          className="hidden gap-1.5 sm:inline-flex"
          disabled={disabled}
          onClick={() => setAction("pr")}
          size="sm"
        >
          <GitPullRequestCreateArrowIcon className="size-4" />
          Open PR
        </Button>
      ) : null}
      {/* Phones get one Git menu instead of two header buttons. */}
      {status.data.push || status.data.pr ? (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="Git actions"
              className="sm:hidden"
              disabled={disabled}
              size="icon-sm"
            >
              <GitBranchIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {status.data.push ? (
              <DropdownMenuItem onSelect={() => setAction("push")}>
                <ArrowUpFromLineIcon />
                Push
              </DropdownMenuItem>
            ) : null}
            {status.data.pr ? (
              <DropdownMenuItem onSelect={() => setAction("pr")}>
                <GitPullRequestCreateArrowIcon />
                Open PR
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <Dialog open={action !== null} onOpenChange={(open) => (open ? null : close())}>
        {action ? (
          <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain sm:max-w-lg">
            <ManualGitDialog
              action={action}
              cachedRunId={checks[`${threadId}:${action}`] ?? null}
              dirty={status.data.dirty}
              onChecked={(runId) =>
                setChecks((current) => ({ ...current, [`${threadId}:${action}`]: runId }))
              }
              onClose={close}
              onAskAgent={(prompt) => {
                close();
                onAskAgent(prompt);
              }}
              threadId={threadId}
              userId={userId}
            />
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}

function ManualGitDialog({
  userId,
  threadId,
  action,
  cachedRunId,
  dirty,
  onChecked,
  onClose,
  onAskAgent,
}: {
  userId: string;
  threadId: string;
  action: Action;
  cachedRunId: string | null;
  dirty: boolean;
  onChecked: (runId: string | null) => void;
  onClose: () => void;
  onAskAgent: (prompt: string) => void;
}) {
  const [text, setText] = useState({ commitMessage: "", title: "", body: "" });
  const start = useMutation(manualGitCheckMutation());
  const confirm = useMutation(manualGitConfirmMutation());
  const [runId, setRunId] = useState(cachedRunId);
  const started = useRef(false);

  const recheck = () => {
    setRunId(null);
    start.mutate(
      { threadId, action },
      {
        onSuccess: (data) => {
          setRunId(data.runId);
          onChecked(data.runId);
        },
      },
    );
  };

  // Without a cached check, one starts with the dialog and runs while the user
  // writes. The ref keeps a development double-mount from starting a second.
  useEffect(() => {
    if (started.current) return;
    started.current = true;

    if (!runId) recheck();
  });

  const checkRun = useQuery(manualGitRunQueryOptions(userId, threadId, runId));

  const writeRun = useQuery(
    manualGitRunQueryOptions(userId, threadId, confirm.data?.runId ?? null),
  );

  const check = checkRun.data?.check ?? null;

  const submit = () => {
    if (!check || !runId) return;
    // A confirmed check is spent; the next dialog checks again.
    onChecked(null);
    confirm.mutate({ threadId, checkRunId: runId, ...text });
  };

  const checkFailed = start.isError || checkRun.isError || checkRun.data?.status === "failed";
  const writing = confirm.isPending || ["queued", "running"].includes(writeRun.data?.status ?? "");
  const result = writeRun.data?.result ?? null;
  const writeFailed = confirm.isError || writeRun.data?.status === "failed";
  const title = action === "push" ? "Push branch" : "Open pull request";

  if (result)
    return (
      <>
        <DialogHeader>
          <DialogTitle>{action === "push" ? "Pushed" : "Pull request opened"}</DialogTitle>
          <DialogDescription>
            {result.pullRequest ? (
              <a
                className="underline"
                href={result.pullRequest.url}
                rel="noreferrer"
                target="_blank"
              >
                Pull request #{result.pullRequest.number}
              </a>
            ) : (
              `${result.branch} is now at ${result.commit.slice(0, 8)} on GitHub.`
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </>
    );

  return (
    <form
      className="flex min-w-0 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>Fields left empty are AI-generated.</DialogDescription>
      </DialogHeader>
      <FieldGroup>
        {action === "pr" ? (
          <>
            <Field>
              <FieldLabel htmlFor="manual-title">Title</FieldLabel>
              <Input
                id="manual-title"
                maxLength={256}
                onChange={(event) => setText({ ...text, title: event.target.value })}
                placeholder="Pull request title"
                value={text.title}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="manual-body">Description</FieldLabel>
              <Textarea
                id="manual-body"
                maxLength={60_000}
                onChange={(event) => setText({ ...text, body: event.target.value })}
                placeholder="What changed and why"
                value={text.body}
              />
            </Field>
          </>
        ) : null}
        {(check?.local.dirty ?? dirty) ? (
          <Field>
            <FieldLabel htmlFor="manual-commit">Commit message</FieldLabel>
            <Textarea
              id="manual-commit"
              maxLength={4000}
              onChange={(event) => setText({ ...text, commitMessage: event.target.value })}
              placeholder="Commit message"
              value={text.commitMessage}
            />
            <FieldDescription>
              {check ? plural(check.local.changedFiles, "uncommitted file") : "Uncommitted files"}{" "}
              will be committed with this message before pushing.
            </FieldDescription>
          </Field>
        ) : null}
      </FieldGroup>
      <section
        aria-live="polite"
        className="flex flex-col gap-2 rounded-lg border border-border p-3"
      >
        {check || checkFailed ? (
          <Button
            className="self-end"
            disabled={writing}
            onClick={recheck}
            size="xs"
            type="button"
            variant="ghost"
          >
            <RefreshCwIcon />
            Check again
          </Button>
        ) : null}
        {check ? (
          <Outcome action={action} check={check} />
        ) : checkFailed ? (
          <p role="alert">
            {checkRun.data?.error ?? "Could not check the branch. Close and try again."}
          </p>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Spinner className="size-3.5" />
            Checking what will happen…
          </p>
        )}
      </section>
      {writeFailed ? (
        <p className="text-sm text-destructive" role="alert">
          {writeRun.data?.error ?? "The request could not be confirmed. Close and check again."}
        </p>
      ) : null}
      <DialogFooter>
        <Button onClick={onClose} type="button" variant="outline">
          Cancel
        </Button>
        <ConfirmButton
          action={action}
          check={check}
          disabled={!check || writing || writeFailed}
          onAskAgent={onAskAgent}
          onConfirm={submit}
          writing={writing}
        />
      </DialogFooter>
    </form>
  );
}

function Outcome({ action, check }: { action: Action; check: ManualGitCheck }) {
  const pushes =
    check.local.dirty ||
    check.push.newBranch ||
    check.push.commits > 0 ||
    check.push.nonFastForward;

  return (
    <div className="flex flex-col gap-4">
      {pushes ? (
        <div className="flex flex-col gap-2">
          {action === "pr" ? <h3 className="text-sm font-medium">First, push the branch</h3> : null}
          <PushImpactView
            changedFiles={check.local.dirty ? check.local.changedFiles : undefined}
            impact={check.push}
            snapshot={check.local.dirty ? check.local.commit : undefined}
          />
        </div>
      ) : null}
      {action === "pr" && check.pr ? (
        <div className="flex flex-col gap-2">
          {pushes ? <h3 className="text-sm font-medium">Then open the pull request</h3> : null}
          <PrImpactView impact={check.pr} />
        </div>
      ) : null}
      {check.push.nonFastForward && check.push.branch === check.defaultBranch ? (
        <p className="text-sm text-destructive" role="alert">
          Force pushing to the default branch is not allowed.
        </p>
      ) : null}
    </div>
  );
}

function ConfirmButton({
  action,
  check,
  disabled,
  writing,
  onAskAgent,
  onConfirm,
}: {
  action: Action;
  check: ManualGitCheck | null;
  disabled: boolean;
  writing: boolean;
  onAskAgent: (prompt: string) => void;
  onConfirm: () => void;
}) {
  if (action === "pr" && check?.pr?.conflicts.length) {
    const { head, base, conflicts } = check.pr;
    // An unpublished branch can be rebased; a published one is merged so the next push stays a fast-forward.
    const rebase = check.push.newBranch;

    return (
      <Button
        onClick={() =>
          onAskAgent(
            `Run \`git fetch origin ${base}\`, then \`git ${rebase ? "rebase" : "merge"} --autostash origin/${base}\` on ${head}, and resolve the conflicts in:\n${conflicts.map((path) => `- ${path}`).join("\n")}\n\nKeep the intent of both sides and run the relevant checks. ${rebase ? "Finish the rebase" : "Commit the merge"}, leave uncommitted changes uncommitted, and don't push.`,
          )
        }
        type="button"
      >
        Fix with agent
      </Button>
    );
  }

  const force = check?.push.nonFastForward ?? false;
  const label = action === "pr" ? "Create pull request" : "Push";

  if (!check || !force)
    return (
      <Button disabled={disabled} type="submit">
        {writing ? <Spinner className="size-3.5" /> : null}
        {label}
      </Button>
    );

  const { branch, overwrittenCommits } = check.push;

  const pull = (
    <Button
      className="flex-1"
      disabled={disabled}
      onClick={() =>
        onAskAgent(
          `GitHub's ${branch} has ${plural(overwrittenCommits, "commit")} the workspace doesn't. Run \`git pull --rebase --autostash origin ${branch}\`, resolve any conflicts keeping the intent of both sides, and run the relevant checks. Leave uncommitted changes uncommitted, and don't push.`,
        )
      }
      type="button"
    >
      Pull with agent
    </Button>
  );

  // The default branch is never force pushed, so pulling is the only way forward.
  if (branch === check.defaultBranch) return pull;

  return (
    <ButtonGroup className="w-full sm:w-auto">
      {pull}
      <ButtonGroupSeparator />
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button aria-label="More push options" disabled={disabled} size="icon" type="button">
            {writing ? <Spinner className="size-3.5" /> : <ChevronDownIcon />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onConfirm} variant="destructive">
            <TriangleAlertIcon />
            {action === "pr" ? "Force push and create pull request" : "Force push"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}
