import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpFromLineIcon, GitPullRequestCreateArrowIcon } from "lucide-react";
import type { ManualGitCheck } from "@cloud-swe/db/manual-git";
import {
  manualGitCheckMutation,
  manualGitConfirmMutation,
  manualGitRunQueryOptions,
  manualGitStatusQueryOptions,
} from "@/lib/queries";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { PrImpactView, PushImpactView } from "./git-impact";

type Action = "push" | "pr";

const generated = "Leave empty to write it from the changes";

/**
 * Header Push and Open PR. Shown only when the sandbox has something to push
 * or a branch without an open PR. Opening the dialog checks in the background
 * what the action would do; confirming is the approval.
 */
export function ManualGit({
  userId,
  threadId,
  running,
  onFixConflicts,
}: {
  userId: string;
  threadId: string;
  running: boolean;
  onFixConflicts: (prompt: string) => void;
}) {
  const [action, setAction] = useState<Action | null>(null);
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
          className="gap-1.5 text-muted-foreground"
          disabled={disabled}
          onClick={() => setAction("push")}
          size="sm"
          variant="ghost"
        >
          <ArrowUpFromLineIcon className="size-4" />
          Push
        </Button>
      ) : null}
      {status.data.pr ? (
        <Button
          className="gap-1.5 text-muted-foreground"
          disabled={disabled}
          onClick={() => setAction("pr")}
          size="sm"
          variant="ghost"
        >
          <GitPullRequestCreateArrowIcon className="size-4" />
          Open PR
        </Button>
      ) : null}
      <Dialog open={action !== null} onOpenChange={(open) => (open ? null : close())}>
        {action ? (
          <DialogContent className="sm:max-w-lg">
            <ManualGitDialog
              action={action}
              dirty={status.data.dirty}
              onClose={close}
              onFixConflicts={(prompt) => {
                close();
                onFixConflicts(prompt);
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
  dirty,
  onClose,
  onFixConflicts,
}: {
  userId: string;
  threadId: string;
  action: Action;
  dirty: boolean;
  onClose: () => void;
  onFixConflicts: (prompt: string) => void;
}) {
  const [text, setText] = useState({ commitMessage: "", title: "", body: "" });
  const start = useMutation(manualGitCheckMutation());
  const confirm = useMutation(manualGitConfirmMutation());
  const started = useRef(false);

  // The check starts with the dialog and runs while the user writes. The ref
  // keeps a development double-mount from submitting a second check run.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    start.mutate({ threadId, action });
  }, [start, threadId, action]);

  const checkRun = useQuery(manualGitRunQueryOptions(userId, threadId, start.data?.runId ?? null));

  const writeRun = useQuery(
    manualGitRunQueryOptions(userId, threadId, confirm.data?.runId ?? null),
  );

  const check = checkRun.data?.check ?? null;
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

        if (check && start.data)
          confirm.mutate({ threadId, checkRunId: start.data.runId, ...text });
      }}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>Fields left empty are written from the changes.</DialogDescription>
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
                placeholder={generated}
                value={text.title}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="manual-body">Description</FieldLabel>
              <Textarea
                id="manual-body"
                maxLength={60_000}
                onChange={(event) => setText({ ...text, body: event.target.value })}
                placeholder={generated}
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
              placeholder={generated}
              value={text.commitMessage}
            />
          </Field>
        ) : null}
      </FieldGroup>
      <section aria-live="polite" className="rounded-lg border border-border p-3">
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
          onFixConflicts={onFixConflicts}
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
  onFixConflicts,
}: {
  action: Action;
  check: ManualGitCheck | null;
  disabled: boolean;
  writing: boolean;
  onFixConflicts: (prompt: string) => void;
}) {
  if (action === "pr" && check?.pr?.conflicts.length) {
    const { head, base, conflicts } = check.pr;

    return (
      <Button
        onClick={() =>
          onFixConflicts(
            `Merge the latest origin/${base} into ${head} and resolve the merge conflicts in:\n${conflicts.map((path) => `- ${path}`).join("\n")}\n\nKeep the intent of both sides, run the relevant checks, and commit the merge.`,
          )
        }
        type="button"
      >
        Fix with agent
      </Button>
    );
  }

  const force = check?.push.nonFastForward ?? false;
  const refused = force && check?.push.branch === check?.defaultBranch;

  return (
    <Button
      disabled={disabled || refused}
      type="submit"
      variant={force ? "destructive" : "default"}
    >
      {writing ? <Spinner className="size-3.5" /> : null}
      {action === "pr"
        ? force
          ? "Force push and create pull request"
          : "Create pull request"
        : force
          ? "Force push"
          : "Push"}
    </Button>
  );
}
