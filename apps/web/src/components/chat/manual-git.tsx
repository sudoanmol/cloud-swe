import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  manualGitPreviewSchema,
  manualGitTextSchema,
  type ManualGitPreview,
  type ManualGitRequest,
} from "@cloud-swe/db/manual-git";
import { submitResultSchema } from "@cloud-swe/api/contracts";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Text = z.infer<typeof manualGitTextSchema>;

export function ManualGit({
  userId,
  threadId,
  running,
}: {
  userId: string;
  threadId: string;
  running: boolean;
}) {
  const [action, setAction] = useState<"push" | "pr_create" | null>(null);
  const client = useQueryClient();

  const available = useQuery({
    queryKey: ["session", userId, "thread", threadId, "manual-git"],
    queryFn: async ({ signal }) =>
      z
        .object({ available: z.boolean() })
        .parse(await api.json(`/api/threads/${threadId}/manual-git`, { signal })),
    refetchInterval: 5000,
    retry: false,
  });

  const start = useMutation({
    mutationFn: async (request: ManualGitRequest) =>
      submitResultSchema.parse(
        await api.mutate(`/api/threads/${threadId}/manual-git`, {
          body: JSON.stringify({ request, clientMessageId: crypto.randomUUID() }),
        }),
      ),
  });

  const draft = useQuery({
    queryKey: ["session", userId, "thread", threadId, "manual-git-text", start.data?.runId],
    enabled: Boolean(action && start.data),
    queryFn: async () =>
      z
        .object({
          status: z.string(),
          preview: manualGitPreviewSchema.nullable(),
          text: manualGitTextSchema.nullable(),
        })
        .parse(
          await api.mutate(`/api/threads/${threadId}/manual-git/${start.data?.runId}/text`, {
            body: "{}",
          }),
        ),
    refetchInterval: (query) =>
      query.state.data?.preview ||
      ["failed", "cancelled", "completed"].includes(query.state.data?.status ?? "")
        ? false
        : 1000,
    retry: false,
  });

  const close = () => {
    setAction(null);
    start.reset();
    void client.invalidateQueries({ queryKey: ["session", userId, "thread", threadId] });
  };

  const disabled = running || action !== null || !available.data?.available || start.isPending;

  if (available.isError) return null;

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => {
          setAction("push");
          start.mutate({ kind: "preview", action: "push", base: "main" });
        }}
      >
        Push
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => {
          setAction("pr_create");
          start.mutate({ kind: "preview", action: "pr_create", base: "main" });
        }}
      >
        Open PR
      </Button>
      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{action === "push" ? "Push branch" : "Open pull request"}</DialogTitle>
          </DialogHeader>
          {start.isError ||
          draft.isError ||
          ["failed", "cancelled"].includes(draft.data?.status ?? "") ? (
            <p role="alert">
              Could not prepare Git changes. Close and refresh before trying again.
            </p>
          ) : null}
          {draft.data?.preview && draft.data.text && start.data && action ? (
            <ManualGitEditor
              key={start.data.runId}
              threadId={threadId}
              previewRunId={start.data.runId}
              action={action}
              preview={draft.data.preview}
              text={draft.data.text}
              onDone={close}
            />
          ) : (
            <p role="status">Preparing changes…</p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ManualGitEditor({
  threadId,
  previewRunId,
  action,
  preview,
  text,
  onDone,
}: {
  threadId: string;
  previewRunId: string;
  action: "push" | "pr_create";
  preview: ManualGitPreview;
  text: Text;
  onDone: () => void;
}) {
  const [clientMessageId] = useState(() => crypto.randomUUID());
  const [values, setValues] = useState(text);
  const [base, setBase] = useState(preview.base);

  const submit = useMutation({
    mutationFn: async () =>
      api.mutate(`/api/threads/${threadId}/manual-git`, {
        body: JSON.stringify({
          clientMessageId,
          request:
            action === "push"
              ? { kind: "push", previewRunId, commitMessage: values.commitMessage }
              : { kind: "pr_create", previewRunId, title: values.title, body: values.body, base },
        }),
      }),
    onSuccess: onDone,
  });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit.mutate();
      }}
    >
      <p>
        {preview.branch} · {preview.head.slice(0, 8)}
      </p>
      <FieldGroup>
        {action === "push" ? (
          preview.dirty ? (
            <Field>
              <FieldLabel htmlFor="manual-commit">Commit message</FieldLabel>
              <Textarea
                id="manual-commit"
                required
                maxLength={4000}
                value={values.commitMessage}
                onChange={(event) => setValues({ ...values, commitMessage: event.target.value })}
              />
            </Field>
          ) : (
            <p>The branch has no uncommitted changes.</p>
          )
        ) : (
          <>
            <Field>
              <FieldLabel htmlFor="manual-title">Title</FieldLabel>
              <Input
                id="manual-title"
                required
                maxLength={256}
                value={values.title}
                onChange={(event) => setValues({ ...values, title: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="manual-body">Description</FieldLabel>
              <Textarea
                id="manual-body"
                maxLength={60000}
                value={values.body}
                onChange={(event) => setValues({ ...values, body: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="manual-base">Base branch</FieldLabel>
              <Input
                id="manual-base"
                required
                value={base}
                onChange={(event) => setBase(event.target.value)}
              />
            </Field>
          </>
        )}
      </FieldGroup>
      {preview.dirty && action === "push" ? (
        <p>Proposing will commit all current changes locally. The push still requires approval.</p>
      ) : (
        <p>The remote write requires approval in the conversation.</p>
      )}
      {submit.isError ? (
        <p role="alert">
          The request could not be confirmed. Close and refresh the thread before retrying.
        </p>
      ) : null}
      <Button type="submit" disabled={submit.isPending || submit.isError}>
        Propose {action === "push" ? "push" : "pull request"}
      </Button>
    </form>
  );
}
