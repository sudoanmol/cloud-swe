import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import type { Environment } from "@cloud-swe/api/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  createEnvironmentMutation,
  deleteEnvironmentMutation,
  environmentsQueryOptions,
  updateEnvironmentMutation,
  type EnvironmentEntryInput,
} from "@/lib/queries";
import { messageForError } from "@/lib/submission-errors";

export const ENVIRONMENT_COPY =
  "Readable by code in the sandbox. Hidden from the transcript, model, and commits. Use development or restricted keys.";

/** Settings → Environments. Values are write-only: the browser never reads them back. */
export function EnvironmentSettings({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const environments = useQuery(environmentsQueryOptions(userId));

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: environmentsQueryOptions(userId).queryKey });

  return (
    <div className="flex flex-col gap-4">
      <CreateEnvironment onCreated={refresh} />
      {environments.isError ? (
        <p className="text-sm text-destructive">{messageForError(environments.error)}</p>
      ) : null}
      {environments.data?.map((environment) => (
        <EnvironmentCard environment={environment} key={environment.id} onChanged={refresh} />
      ))}
    </div>
  );
}

function CreateEnvironment({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [dotenv, setDotenv] = useState("");
  const create = useMutation(createEnvironmentMutation());

  return (
    <form
      className="flex flex-col gap-2 rounded-xl border border-border/50 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate(
          { name: name.trim(), dotenv },
          {
            onSuccess: () => {
              setName("");
              setDotenv("");
              onCreated();
            },
          },
        );
      }}
    >
      <Input
        aria-label="Environment name"
        maxLength={80}
        onChange={(event) => setName(event.target.value)}
        placeholder="Environment name, for example development"
        value={name}
      />
      <Textarea
        aria-label=".env contents"
        className="min-h-24 font-mono text-xs"
        onChange={(event) => setDotenv(event.target.value)}
        placeholder={"Paste .env contents\nAPI_KEY=sk-...\nPORT=3000"}
        spellCheck={false}
        value={dotenv}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={create.isPending || !name.trim()} size="sm" type="submit">
          Create environment
        </Button>
        <label className="cursor-pointer text-xs text-muted-foreground underline-offset-2 hover:underline">
          Upload .env
          <input
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];

              if (file) void file.text().then(setDotenv);
              event.target.value = "";
            }}
            type="file"
          />
        </label>
        <span className="text-xs text-muted-foreground">
          Values of 8 or more characters are secret by default.
        </span>
      </div>
      {create.isError ? (
        <p className="text-sm text-destructive">{messageForError(create.error)}</p>
      ) : null}
    </form>
  );
}

type Row = { key: string; name: string; secret: boolean; value: string; saved: string | null };

function rowsFor(environment: Environment): Row[] {
  return environment.revision.entries.map((entry) => ({
    key: entry.name,
    name: entry.name,
    secret: entry.secret,
    value: "",
    saved: entry.name,
  }));
}

function EnvironmentCard({
  environment,
  onChanged,
}: {
  environment: Environment;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(environment.name);
  const [rows, setRows] = useState<Row[]>(() => rowsFor(environment));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const update = useMutation(updateEnvironmentMutation());
  const remove = useMutation(deleteEnvironmentMutation());

  const edit = (key: string, patch: Partial<Row>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const entries = environment.revision.entries;

  if (!editing)
    return (
      <div className="flex items-center gap-3 rounded-xl border border-border/50 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{environment.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            Revision {environment.revision.number} · {entries.length}{" "}
            {entries.length === 1 ? "variable" : "variables"}
            {entries.length > 0 ? `: ${entries.map((entry) => entry.name).join(", ")}` : ""}
          </p>
        </div>
        <Button
          onClick={() => {
            setName(environment.name);
            setRows(rowsFor(environment));
            setEditing(true);
          }}
          size="sm"
          variant="outline"
        >
          Edit
        </Button>
        <Button
          disabled={remove.isPending}
          onClick={() => {
            if (!confirmDelete) {
              setConfirmDelete(true);

              return;
            }

            remove.mutate(environment.id, { onSuccess: onChanged });
          }}
          onBlur={() => setConfirmDelete(false)}
          size="sm"
          variant={confirmDelete ? "destructive" : "ghost"}
        >
          {confirmDelete ? "Delete for all threads" : "Delete"}
        </Button>
      </div>
    );

  return (
    <form
      className="flex flex-col gap-2 rounded-xl border border-border/50 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        update.mutate(
          {
            id: environment.id,
            name: name.trim(),
            entries: rows.map((row) => {
              const entry: EnvironmentEntryInput = { name: row.name.trim(), secret: row.secret };

              // A blank value keeps the saved one; the browser never reads it back.
              if (row.value) entry.value = row.value;

              if (row.saved) entry.previousName = row.saved;

              return entry;
            }),
          },
          {
            onSuccess: () => {
              setEditing(false);
              onChanged();
            },
          },
        );
      }}
    >
      <Input
        aria-label="Environment name"
        maxLength={80}
        onChange={(event) => setName(event.target.value)}
        value={name}
      />
      {rows.map((row) => (
        <div className="flex items-center gap-2" key={row.key}>
          <Input
            aria-label="Variable name"
            className="font-mono text-xs"
            onChange={(event) => edit(row.key, { name: event.target.value })}
            placeholder="NAME"
            value={row.name}
          />
          <Input
            aria-label={`Value for ${row.name || "new variable"}`}
            autoComplete="off"
            className="font-mono text-xs"
            onChange={(event) => edit(row.key, { value: event.target.value })}
            placeholder={row.saved ? "Set. Leave blank to keep" : "Value"}
            type={row.secret ? "password" : "text"}
            value={row.value}
          />
          <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <input
              checked={row.secret}
              onChange={(event) => edit(row.key, { secret: event.target.checked })}
              type="checkbox"
            />
            Secret
          </label>
          <Button
            aria-label={`Remove ${row.name || "variable"}`}
            onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <Trash2Icon className="size-4" />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() =>
            setRows((current) => [
              ...current,
              { key: crypto.randomUUID(), name: "", secret: true, value: "", saved: null },
            ])
          }
          size="sm"
          type="button"
          variant="outline"
        >
          <PlusIcon data-icon="inline-start" />
          Add variable
        </Button>
        <Button disabled={update.isPending || !name.trim()} size="sm" type="submit">
          Save revision
        </Button>
        <Button onClick={() => setEditing(false)} size="sm" type="button" variant="ghost">
          Cancel
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Saving creates a new revision. Existing threads keep their revision until you update them.
      </p>
      {update.isError ? (
        <p className="text-sm text-destructive">{messageForError(update.error)}</p>
      ) : null}
    </form>
  );
}
