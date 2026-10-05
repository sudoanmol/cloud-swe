import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ThreadSummary } from "@cloud-swe/api/contracts";
import { deleteThreadMutation, renameThreadMutation } from "@/lib/queries";
import { messageForError } from "@/lib/submission-errors";

export type ThreadAction = { kind: "rename" | "delete"; thread: ThreadSummary };

/** The rename or delete dialog for a sidebar thread; `action` null closes it. */
export function ThreadActionDialog({
  action,
  onClose,
  userId,
}: {
  action: ThreadAction | null;
  onClose: () => void;
  userId: string;
}) {
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open={action !== null}>
      <DialogContent>
        {action?.kind === "rename" ? (
          <RenameForm onClose={onClose} thread={action.thread} userId={userId} />
        ) : action?.kind === "delete" ? (
          <DeleteConfirm onClose={onClose} thread={action.thread} userId={userId} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({ onClose, thread, userId }: ActionProps) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(thread.title ?? "");
  const rename = useMutation(renameThreadMutation());
  const trimmed = title.trim();

  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        rename.mutate(
          { threadId: thread.id, title: trimmed },
          {
            onSuccess: () => {
              void queryClient.invalidateQueries({ queryKey: ["session", userId, "threads"] });
              void queryClient.invalidateQueries({
                queryKey: ["session", userId, "thread", thread.id],
              });
              onClose();
            },
          },
        );
      }}
    >
      <DialogHeader>
        <DialogTitle>Rename thread</DialogTitle>
      </DialogHeader>
      <Input
        aria-label="Thread title"
        autoFocus
        maxLength={80}
        onChange={(event) => setTitle(event.target.value)}
        onFocus={(event) => event.target.select()}
        value={title}
      />
      {rename.isError ? (
        <p className="text-sm text-destructive">{messageForError(rename.error)}</p>
      ) : null}
      <DialogFooter>
        <Button onClick={onClose} type="button" variant="outline">
          Cancel
        </Button>
        <Button disabled={!trimmed || rename.isPending} type="submit">
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

function DeleteConfirm({ onClose, thread, userId }: ActionProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const activeId = useParams({ strict: false }).id;
  const remove = useMutation(deleteThreadMutation());

  return (
    <>
      <DialogHeader>
        <DialogTitle>Delete thread?</DialogTitle>
        <DialogDescription>
          “{thread.title ?? "New agent"}” and its workspace will be permanently deleted.
        </DialogDescription>
      </DialogHeader>
      {remove.isError ? (
        <p className="text-sm text-destructive">{messageForError(remove.error)}</p>
      ) : null}
      <DialogFooter>
        <Button onClick={onClose} type="button" variant="outline">
          Cancel
        </Button>
        <Button
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(thread.id, {
              onSuccess: () => {
                void queryClient.invalidateQueries({ queryKey: ["session", userId, "threads"] });

                if (thread.id === activeId) void navigate({ to: "/" });
                onClose();
              },
            })
          }
          type="button"
          variant="destructive"
        >
          Delete
        </Button>
      </DialogFooter>
    </>
  );
}

type ActionProps = { onClose: () => void; thread: ThreadSummary; userId: string };
