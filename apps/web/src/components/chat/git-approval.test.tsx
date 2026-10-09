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

function operation(request: GitRequest) {
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
    expect(render()).toContain("Deny");
    expect(render()).not.toContain("SECRET DIFF");
    op.execution = "unknown";
    expect(render()).toContain("Do not retry manually");
    expect(render()).not.toContain(">Approve<");
  }
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ManualGit, ManualGitEditor } from "./manual-git";
import { PrImpactView } from "./git-impact";
import { gitDecisionMutation } from "@/lib/queries";

const preview = {
  head: "a".repeat(40),
  branch: "feature",
  base: "main",
  dirty: true,
  fingerprint: "b".repeat(64),
  commits: "Commit title",
  stat: "1 file changed",
  diff: "+change",
  generation: 1,
};

test("manual controls disable during a run or unsettled commands, and defaults are editable", () => {
  const client = new QueryClient();
  const key = ["session", "u", "thread", "t", "manual-git"];
  client.setQueryData(key, { available: true });

  const controls = (running: boolean) =>
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ManualGit userId="u" threadId="t" running={running} />
      </QueryClientProvider>,
    );

  expect(controls(true).match(/disabled=""/g)?.length).toBe(2);
  expect(controls(false)).not.toContain('disabled=""');
  client.setQueryData(key, { available: false });
  expect(controls(false).match(/disabled=""/g)?.length).toBe(2);

  for (const action of ["push", "pr_create"] as const) {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ManualGitEditor
          threadId="t"
          previewRunId="r"
          action={action}
          preview={preview}
          text={{
            commitMessage: "Suggested commit",
            title: "Suggested title",
            body: "Suggested body",
          }}
          onDone={() => undefined}
        />
      </QueryClientProvider>,
    );

    expect(html).toContain(action === "push" ? "Suggested commit" : "Suggested title");
    expect(html).not.toContain("readOnly");
    expect(html).toContain("Propose");
  }

  client.clear();
});

test("a PR preview names conflicting files or says it merges cleanly", () => {
  const impact = {
    head: "feature",
    base: "main",
    commits: 2,
    behind: 1,
    files: 3,
    additions: 10,
    deletions: 4,
    conflictsTruncated: false,
  };

  const conflicted = renderToStaticMarkup(
    <PrImpactView impact={{ ...impact, conflicts: ["src/app.ts"] }} />,
  );

  expect(conflicted).toContain("1 file conflict with main");
  expect(conflicted).toContain("src/app.ts");
  expect(renderToStaticMarkup(<PrImpactView impact={{ ...impact, conflicts: [] }} />)).toContain(
    "No conflicts",
  );
});

test("approval mutation sends the stored digest and CSRF header", async () => {
  const original = globalThis.fetch;
  const op = operation({ kind: "pr_ready", number: 1 });
  globalThis.fetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-csrf-protection")).toBe("1");
      expect(JSON.parse(String(init?.body))).toEqual({
        decision: "approve",
        digest: op.proposal.digest,
      });

      return Response.json(op);
    },
    { preconnect: fetch.preconnect },
  );

  try {
    const fn = gitDecisionMutation().mutationFn;

    if (!fn) throw new Error("Decision mutation missing");
    await fn(
      { threadId: op.threadId, id: op.id, digest: op.proposal.digest, decision: "approve" },
      { client: new QueryClient(), meta: undefined, mutationKey: undefined },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("force approvals explain the overwrite and settled states replace decision controls", () => {
  const op = operation({ kind: "push", source: "HEAD", branch: "feature", force: true });
  op.proposal.impact = {
    push: {
      branch: "feature",
      compareBranch: null,
      newBranch: false,
      commits: 2,
      files: 1,
      additions: 1,
      deletions: 1,
      nonFastForward: true,
      overwrittenCommits: 7,
    },
  };

  const render = () =>
    renderToStaticMarkup(
      <GitApprovalCard operation={op} pending={false} error={null} onDecision={() => undefined} />,
    );

  expect(render()).toContain("Force push replaces 7 commits on GitHub");

  for (const [state, label] of [
    ["approved", "approved"],
    ["rejected", "denied"],
    ["expired", "expired"],
    ["invalidated", "invalidated"],
  ] as const) {
    op.approval = state;
    expect(render()).toContain(label);
    expect(render()).not.toContain(">Approve<");
  }

  for (const state of ["executing", "succeeded", "failed", "unknown"] as const) {
    op.execution = state;
    expect(render()).toContain(state);
  }
});
