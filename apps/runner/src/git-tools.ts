import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  gitOperationSchema,
  gitProposalSchema,
  gitRequestSchema,
  gitReadSchema,
  type GitContext,
  type GitProposal,
} from "@cloud-swe/db/git-contracts";
import type { JsonObject } from "@cloud-swe/db/json";
import { ThreadStoreError } from "@cloud-swe/db/thread-contracts";
import { quoteShell } from "./text.js";
import type { CommandRequest, CommandResult } from "./sandbox.js";

type Execute = (request: CommandRequest) => Promise<CommandResult>;

export type PiGitTools = ReturnType<typeof createPiGitTools>;

const toolSchemas = {
  git_push: Type.Object({ source: Type.String(), branch: Type.String() }),
  github_pr_create: Type.Object({
    title: Type.String(),
    body: Type.String(),
    head: Type.String(),
    base: Type.String(),
    draft: Type.Optional(Type.Boolean()),
  }),
  github_pr_update: Type.Object({
    number: Type.Number(),
    title: Type.Optional(Type.String()),
    body: Type.Optional(Type.String()),
  }),
  github_pr_close: Type.Object({ number: Type.Number() }),
  github_pr_reopen: Type.Object({ number: Type.Number() }),
  github_pr_comment: Type.Object({ number: Type.Number(), body: Type.String() }),
  github_pr_merge: Type.Object({
    number: Type.Number(),
    method: Type.Union([Type.Literal("merge"), Type.Literal("squash"), Type.Literal("rebase")]),
  }),
  github_pr_read: Type.Object({
    action: Type.Union([
      Type.Literal("list"),
      Type.Literal("view"),
      Type.Literal("diff"),
      Type.Literal("checks"),
      Type.Literal("comments"),
    ]),
    number: Type.Optional(Type.Number()),
    page: Type.Optional(Type.Number()),
  }),
};

const kindByTool = {
  git_push: "push",
  github_pr_create: "pr_create",
  github_pr_update: "pr_update",
  github_pr_close: "pr_close",
  github_pr_reopen: "pr_reopen",
  github_pr_comment: "pr_comment",
  github_pr_merge: "pr_merge",
} as const;

export function createGitBrokerClient(
  config: { url: string; secret: string },
  context: GitContext,
  signal: AbortSignal,
) {
  return {
    async call(path: "access" | "upload" | "prepare" | "execute" | "read", data: JsonObject = {}) {
      let response: Response;

      try {
        response = await fetch(`${config.url}/internal/git/${path}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${config.secret}`, "Content-Type": "application/json" },
          body: JSON.stringify(
            path === "access" || path === "upload" ? context : { context, ...data },
          ),
          signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
          redirect: "error",
        });
      } catch {
        throw new ThreadStoreError("GIT_UPSTREAM_FAILED", "Git broker unavailable", 502);
      }

      if (!response.ok) {
        const error = z
          .object({ error: z.object({ code: z.string() }) })
          .safeParse(await response.json().catch(() => null));

        throw new ThreadStoreError(
          error.success ? error.data.error.code : "GIT_UPSTREAM_FAILED",
          "Git broker request failed",
          response.status,
        );
      }

      return response.json();
    },
  };
}

export function createPiGitTools(input: {
  client: ReturnType<typeof createGitBrokerClient>;
  exec: Execute;
  maxBytes: number;
  minFreeBytes: number;
}) {
  let pending: GitProposal | undefined;
  let accessExpires = 0;
  let refreshing: Promise<void> | undefined;

  async function checked(request: CommandRequest) {
    const result = await input.exec(request);

    if (result.kind !== "completed" || result.statusCode !== 0 || result.outputTruncated)
      throw new ThreadStoreError("GIT_BUNDLE_INVALID", "Git preparation failed");

    return result.stdout.trim();
  }

  async function refreshAccess(force = false) {
    if (refreshing) return refreshing;

    if (!force && accessExpires - Date.now() > 300_000) return;

    refreshing = (async () => {
      const access = z
        .object({ repositoryUrl: z.url(), url: z.url(), token: z.string(), expires: z.number() })
        .parse(await input.client.call("access"));

      const config = `[url ${JSON.stringify(access.url)}]\n\tinsteadOf = ${access.repositoryUrl}\n[http ${JSON.stringify(access.url)}]\n\textraHeader = Authorization: Bearer ${access.token}\n`;
      await checked({
        command:
          "install -d -m 0700 /var/lib/cloud-swe && umask 077 && cat > /var/lib/cloud-swe/git.config.tmp && mv /var/lib/cloud-swe/git.config.tmp /var/lib/cloud-swe/git.config",
        stdin: config,
      });
      accessExpires = access.expires;
    })().finally(() => {
      refreshing = undefined;
    });

    return refreshing;
  }

  async function pushBundle() {
    const upload = z
      .object({ id: z.uuid(), url: z.url(), token: z.string() })
      .parse(await input.client.call("upload"));

    return upload;
  }

  const tools: ToolDefinition[] = Object.entries(toolSchemas).map(([name, parameters]) => ({
    name,
    label: name,
    parameters,
    description:
      name === "github_pr_read"
        ? "Read the thread repository's GitHub PRs, diffs, checks, or comments through the broker."
        : "Propose a GitHub modification for user approval. Does not execute the modification until approval is recorded by the backend.",
    executionMode: "sequential",
    execute: async (toolCallId, params) => {
      if (pending)
        return {
          content: [{ type: "text", text: "Not executed: waiting for the pending Git approval." }],
          details: { skipped: true },
          terminate: true,
        };

      if (name === "github_pr_read") {
        const result = await input.client.call("read", { read: gitReadSchema.parse(params) });

        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      }

      const key = z
        .enum([
          "git_push",
          "github_pr_create",
          "github_pr_update",
          "github_pr_close",
          "github_pr_reopen",
          "github_pr_comment",
          "github_pr_merge",
        ])
        .parse(name);

      const fields = z.record(z.string(), z.unknown()).parse(params);
      const request = gitRequestSchema.parse({ ...fields, kind: kindByTool[key] });
      let push: { id: string; commit: string } | undefined;

      if (request.kind === "push") {
        await refreshAccess();
        const upload = await pushBundle();
        const path = `/var/lib/cloud-swe/export-${randomUUID()}`;
        const command = `set -eu\numask 077\nexport GIT_CONFIG_GLOBAL=/var/lib/cloud-swe/git.config GIT_TERMINAL_PROMPT=0\ncd /workspace\ncommit=$(git rev-parse --verify ${quoteShell(`${request.source}^{commit}`)})\nexport_dir=${quoteShell(path)}\nmkdir -m 700 "$export_dir"\ntrap 'rm -rf -- "$export_dir"' EXIT\ncat > "$export_dir/curl.config"\nwork_pid=$$\ntimeout_pid=$PPID\nulimit -f ${Math.max(1, Math.floor(input.maxBytes / 1024))}\n(while kill -0 "$work_pid" 2>/dev/null; do size=$(du -sk /workspace "$export_dir" | awk '{sum += $1} END {printf "%.0f\\n", sum * 1024}'); free=$(df -Pk /workspace | awk 'NR==2 {printf "%.0f\\n", $4 * 1024}'); if [ "$size" -gt ${input.maxBytes} ] || [ "$free" -lt ${input.minFreeBytes} ]; then kill -TERM "$timeout_pid"; exit; fi; sleep 0.2; done) &\nmonitor=$!\ntrap 'kill "$monitor" 2>/dev/null || true; rm -rf -- "$export_dir"' EXIT\nif [ "$(git rev-parse --is-shallow-repository)" = true ]; then git -c core.hooksPath=/dev/null fetch --unshallow --no-tags origin; fi\ngit -c core.hooksPath=/dev/null update-ref refs/cloud-swe/export/${upload.id} "$commit"\ntrap 'kill "$monitor" 2>/dev/null || true; git update-ref -d refs/cloud-swe/export/${upload.id}; rm -rf -- "$export_dir"' EXIT\ngit bundle create "$export_dir/source.bundle" refs/cloud-swe/export/${upload.id}\n[ "$(stat -c %s "$export_dir/source.bundle")" -le ${input.maxBytes} ]\ncurl --silent --fail --max-time 240 --config "$export_dir/curl.config" --upload-file "$export_dir/source.bundle" --request POST ${quoteShell(upload.url)} >/dev/null\nprintf '%s' "$commit"`;

        const commit = await checked({
          command: `timeout --kill-after=5 240 sh -c ${quoteShell(command)}`,
          stdin: `header = "Authorization: Bearer ${upload.token}"\nheader = "Content-Type: application/octet-stream"\n`,
          timeoutMs: 240_000,
        });

        push = { id: upload.id, commit };
      }

      pending = gitProposalSchema.parse(
        await input.client.call("prepare", { request, toolCallId, push }),
      );

      return {
        content: [
          {
            type: "text",
            text: `Waiting for user approval of operation ${pending.id}. No GitHub modification has executed.`,
          },
        ],
        details: { approvalId: pending.id, status: "awaiting_approval" },
        terminate: true,
      };
    },
  }));

  return {
    tools,
    refreshAccess,
    pending: () => pending,
    receipt: async (id: string) =>
      gitOperationSchema.parse(await input.client.call("execute", { id })),
  };
}
