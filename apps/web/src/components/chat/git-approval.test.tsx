import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { gitOperationSchema, type GitRequest } from "@cloud-swe/db/git-contracts";
import { GitApprovalCard } from "./git-approval";

const requests: GitRequest[] = [
  { kind: "pr_ready", number: 1 },
  { kind: "pr_review_reply", number: 1, commentId: 5, body: "Reply" },
  { kind: "pr_review_resolve", threadId: "thread-1" },
  { kind: "push", source: "HEAD", branch: "feature" },
  {
    kind: "pr_create",
    title: "A title",
    body: "A body",
    head: "feature",
    base: "main",
    draft: false,
  },
  { kind: "pr_update", number: 1, title: "Updated" },
  { kind: "pr_close", number: 1 },
  { kind: "pr_reopen", number: 1 },
  { kind: "pr_comment", number: 1, body: "Comment text" },
  { kind: "pr_merge", number: 1, method: "squash" },
];

export function operation(request: GitRequest) {
  const id = "11111111-1111-4111-8111-111111111111";

  return gitOperationSchema.parse({
    id,
    runId: id,
    threadId: id,
    userId: "u",
    generation: 1,
    proposal: {
      id,
      toolCallId: "tool",
      repositoryUrl: "https://github.com/acme/repo.git",
      repositoryId: 1,
      request,
      expectedHead: "a".repeat(40),
      base: "main",
      commit: "b".repeat(40),
      bundleHash: null,
      preview: "SECRET DIFF",
      digest: "c".repeat(64),
    },
    approval: "pending",
    execution: "not_started",
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    decidedAt: null,
    result: null,
  });
}

test("every proposal has decisions; push hides the diff and unknown forbids retry", () => {
  for (const request of requests) {
    const op = operation(request);

    const render = () =>
      renderToStaticMarkup(
        <GitApprovalCard
          operation={op}
          pending={false}
          error={null}
          onDecision={() => undefined}
        />,
      );

    expect(render()).toContain("Approve");
    expect(render()).toContain("Reject");
    expect(render()).not.toContain("SECRET DIFF");
    op.execution = "unknown";
    expect(render()).toContain("Do not retry manually");
    expect(render()).not.toContain(">Approve<");
  }
});
