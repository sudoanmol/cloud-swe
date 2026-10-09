import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GitOperation } from "@cloud-swe/db/git-contracts";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { gitDecisionMutation, gitOperationQueryOptions } from "@/lib/queries";
import { Markdown } from "./markdown";
import { BranchFlow, PrImpactView, PushImpactView } from "./git-impact";

export function GitApproval({
  userId,
  threadId,
  id,
}: {
  userId: string;
  threadId: string;
  id: string;
}) {
  const options = gitOperationQueryOptions(userId, threadId, id);
  const query = useQuery(options);
  const client = useQueryClient();
  const decision = useMutation(gitDecisionMutation());

  if (!query.data)
    return (
      <p role="status">
        {query.isError ? "Could not load Git approval." : "Loading Git approval…"}
        <Button variant="ghost" onClick={() => void query.refetch()}>
          Refresh
        </Button>
      </p>
    );

  return (
    <GitApprovalCard
      operation={query.data}
      pending={decision.isPending}
      error={decision.isError ? "Decision could not be saved. Refresh before trying again." : null}
      onDecision={(value) =>
        decision.mutate(
          { threadId, id, digest: query.data.proposal.digest, decision: value },
          { onSettled: () => void client.invalidateQueries({ queryKey: options.queryKey }) },
        )
      }
    />
  );
}

const labels = {
  pr_ready: "Mark ready for review",
  pr_review_reply: "Reply to review comment",
  pr_review_resolve: "Resolve review thread",
  push: "Push branch",
  pr_create: "Create pull request",
  pr_update: "Update pull request",
  pr_close: "Close pull request",
  pr_reopen: "Reopen pull request",
  pr_comment: "Comment on pull request",
  pr_merge: "Merge pull request",
};

/** What approving does, in the same terms as the manual Push and Open PR dialogs. */
function Effect({ proposal }: { proposal: GitOperation["proposal"] }) {
  const r = proposal.request;
  const pr = proposal.pullRequest;

  const flow = pr ? (
    <BranchFlow from={pr.head} fromLabel="Merge" to={pr.base} toLabel="Into" />
  ) : null;

  switch (r.kind) {
    case "push":
      return proposal.impact?.push ? (
        <PushImpactView impact={proposal.impact.push} />
      ) : (
        <p>
          Push {proposal.commit?.slice(0, 8)} to {r.branch}.
        </p>
      );
    case "pr_create":
      return (
        <>
          <p className="font-medium">{r.title}</p>
          {r.body ? <Markdown>{r.body}</Markdown> : null}
          {proposal.impact?.pr ? (
            <PrImpactView impact={proposal.impact.pr} />
          ) : (
            <BranchFlow from={r.head} fromLabel="Merge" to={r.base} toLabel="Into" />
          )}
          {r.draft ? <p className="text-muted-foreground">Opens as a draft.</p> : null}
        </>
      );
    case "pr_update":
      return (
        <>
          <p>Change pull request #{r.number}:</p>
          {r.title !== undefined ? (
            <p>
              Title: <span className="font-medium">{r.title}</span>
              {pr ? <span className="text-muted-foreground"> (was “{pr.title}”)</span> : null}
            </p>
          ) : null}
          {r.body !== undefined ? <Markdown>{r.body}</Markdown> : null}
        </>
      );
    case "pr_merge":
      return (
        <>
          <p>
            Merge pull request #{r.number} with a {r.method} merge.
          </p>
          {flow}
        </>
      );
    case "pr_ready":
      return (
        <>
          <p>Mark draft pull request #{r.number} ready for review.</p>
          {flow}
        </>
      );
    case "pr_close":
      return <p>Close pull request #{r.number} without merging.</p>;
    case "pr_reopen":
      return <p>Reopen pull request #{r.number}.</p>;
    case "pr_comment":
      return (
        <>
          <p>Comment on pull request #{r.number}:</p>
          <Markdown>{r.body}</Markdown>
        </>
      );
    case "pr_review_reply":
      return (
        <>
          <p>
            Reply to review comment {r.commentId} on pull request #{r.number}:
          </p>
          <Markdown>{r.body}</Markdown>
        </>
      );
    case "pr_review_resolve":
      return (
        <p>
          Resolve review thread {r.threadId}
          {pr ? ` on pull request #${pr.number}` : ""}.
        </p>
      );
  }
}

export function GitApprovalCard({
  operation,
  pending,
  error,
  onDecision,
}: {
  operation: GitOperation;
  pending: boolean;
  error: string | null;
  onDecision: (decision: "approve" | "reject") => void;
}) {
  const status =
    operation.execution !== "not_started"
      ? operation.execution
      : operation.approval === "pending" && operation.expiresAt.getTime() <= Date.now()
        ? "expired"
        : operation.approval;

  return (
    <Alert>
      <AlertTitle>
        {labels[operation.proposal.request.kind]} · {status === "rejected" ? "denied" : status}
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        <Effect proposal={operation.proposal} />
        {status === "unknown" ? (
          <p role="alert">
            The remote outcome is unknown. Do not retry manually. The server will reconcile this
            operation.
          </p>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        {status === "pending" ? (
          <div className="flex gap-2">
            <Button disabled={pending} onClick={() => onDecision("approve")} size="sm">
              Approve
            </Button>
            <Button
              disabled={pending}
              onClick={() => onDecision("reject")}
              size="sm"
              variant="outline"
            >
              Deny
            </Button>
          </div>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
