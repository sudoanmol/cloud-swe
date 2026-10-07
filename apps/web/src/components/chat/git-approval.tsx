import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GitOperation } from "@cloud-swe/db/git-contracts";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { gitDecisionMutation, gitOperationQueryOptions } from "@/lib/queries";
import { Markdown } from "./markdown";

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
  push: "Push branch",
  pr_create: "Create pull request",
  pr_update: "Update pull request",
  pr_close: "Close pull request",
  pr_reopen: "Reopen pull request",
  pr_comment: "Comment on pull request",
  pr_merge: "Merge pull request",
};

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
  const p = operation.proposal;
  const r = p.request;

  const status =
    operation.execution !== "not_started"
      ? operation.execution
      : operation.approval === "pending" && operation.expiresAt.getTime() <= Date.now()
        ? "expired"
        : operation.approval;

  return (
    <Alert>
      <AlertTitle>
        {labels[r.kind]} · {status}
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        {r.kind === "push" ? (
          <dl>
            <dt>Commit</dt>
            <dd className="break-all">{p.commit}</dd>
            <dt>Destination branch</dt>
            <dd>{r.branch}</dd>
            <dt>Expected destination SHA</dt>
            <dd className="break-all">{p.expectedHead ?? "New branch"}</dd>
          </dl>
        ) : null}
        {"number" in r ? <p>Pull request #{r.number}</p> : null}
        {"title" in r && r.title ? <p>{r.title}</p> : null}
        {"body" in r && r.body !== undefined ? <Markdown>{r.body}</Markdown> : null}
        {r.kind === "pr_create" ? (
          <p>
            {r.head} → {r.base}
          </p>
        ) : null}
        {r.kind === "pr_update" ? (
          <p>
            Head: {p.expectedHead} · Base: {p.base}
          </p>
        ) : null}
        {r.kind === "pr_merge" ? <p>Method: {r.method}</p> : null}
        {status === "unknown" ? (
          <p role="alert">
            The remote outcome is unknown. Do not retry manually. The server will reconcile this
            operation.
          </p>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        {status === "pending" ? (
          <div className="flex gap-2">
            <Button disabled={pending} onClick={() => onDecision("approve")}>
              Approve
            </Button>
            <Button variant="outline" disabled={pending} onClick={() => onDecision("reject")}>
              Reject
            </Button>
          </div>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
