import { Effect } from "effect";
import { z } from "zod";
import { CancelledFailure } from "@temporalio/common";
import { agentBrowserConfigPath, relayUrl, signRelayCapability } from "@cloud-swe/db/browser-relay";
import { decodeLivePiSessionEntries } from "@cloud-swe/db/checkpoint";
import { gitExecutionElapsed, type GitOperation } from "@cloud-swe/db/git-contracts";
import { previewUrlTemplate } from "@cloud-swe/db/previews";
import { publicFailureForCode, publicFailureMessage } from "@cloud-swe/db/public-failure";
import { skillMetadataSchema } from "@cloud-swe/db/skills";
import {
  WORKSPACE_RESET_INSTRUCTION,
  type CheckpointRecord,
  type WorkspaceRecord,
} from "@cloud-swe/db/thread-contracts";
import {
  activityAttemptId,
  nonRetryable,
  requireModelCredentials,
  runIsActive,
  workspaceRef,
  type ActiveRun,
  type ActivityContext,
  type RunExecutionResult,
} from "./activity-support.js";
import {
  attachmentImageReferences,
  attachmentManifest,
  checkpointAttachmentIds,
  hydrateCheckpointEntries,
  materializeAttachments,
  promptImages,
} from "./attachments.js";
import { createDiffStatRefresher, readDiffStat } from "./diff-stat.js";
import { createGitBrokerClient, createPiGitTools } from "./git-tools.js";
import { createPiExecutor, type PiExecutorOutput } from "./pi.js";
import {
  PiCheckpointLimitError,
  PiCheckpointSerializationError,
  parsePiSessionMetadata,
} from "./pi-checkpoint.js";
import { scopePiAttemptEvent, scopeScriptedAttemptEvent, type PiEvent } from "./pi-events.js";
import { createPiQuestionTools } from "./question-tools.js";
import { discoverRemoteResources, expandRemoteSkill } from "./remote-resources.js";
import type { SandboxProvider } from "./sandbox.js";
import { runScripted as executeScripted, scriptedCheckpointSchema } from "./scripted.js";
import { createWebTools } from "./web-tools.js";
import type { WorkspaceLifecycle } from "./workspace-lifecycle.js";

const checkpointSummarySchema = z.object({
  generation: z.number().int().optional(),
  text: z.string().optional(),
  startedAt: z.number().optional(),
});

function checkpointContent(checkpoint: CheckpointRecord | null) {
  return checkpointSummarySchema.safeParse(checkpoint?.content).data ?? null;
}

function sessionMetadataFromCheckpoint(checkpoint: CheckpointRecord | null) {
  if (!checkpoint) return undefined;

  const metadata = parsePiSessionMetadata(checkpoint.content);

  if (!metadata) throw nonRetryable("INVALID_CHECKPOINT");

  return metadata;
}

function checkpointGeneration(checkpoint: CheckpointRecord | null): number | undefined {
  const content = checkpointContent(checkpoint);
  const value = checkpoint?.generation ?? content?.generation;

  return value !== undefined && Number.isSafeInteger(value) ? value : undefined;
}

function checkpointText(checkpoint: CheckpointRecord | null): string | undefined {
  const content = checkpointContent(checkpoint);

  return content?.text;
}

type CoordinatedSandbox = ReturnType<WorkspaceLifecycle["coordinatedSandbox"]>;

/** One Pi activity attempt: the fenced workspace it owns and everything discovered in it. */
type PiRun = {
  initial: ActiveRun;
  attemptId: string;
  provider: SandboxProvider;
  workspace: WorkspaceRecord;
  ownershipToken: string;
  commandSandbox: CoordinatedSandbox;
  threadAttachments: Awaited<ReturnType<ActivityContext["store"]["listThreadAttachments"]>>;
  runAttachments: Awaited<ReturnType<ActivityContext["store"]["attachmentsForRun"]>>;
  resources: Awaited<ReturnType<typeof discoverRemoteResources>>;
  startedAt: number;
};

type ObservedEnvironment = { os: string; shell: string; branch: string | null };

/** Run execution: the Pi and scripted bodies, their completion, and failure finalization. */
export function createRunExecution(ctx: ActivityContext, lifecycle: WorkspaceLifecycle) {
  const { store, gitStore, logger, config, attachmentObjects } = ctx;

  async function assertActive(runId: string, startedAt: number): Promise<ActiveRun> {
    const run = await store.loadRun(runId);

    if (!runIsActive(run)) throw nonRetryable("RUN_TERMINAL");

    if (run.cancelRequestedAt) throw new CancelledFailure("Cancellation requested");

    if (
      gitExecutionElapsed({ ...run, agentStartedAt: run.agentStartedAt ?? new Date(startedAt) }) >=
      config.maxRunMs
    )
      throw nonRetryable("RUN_TIMEOUT");

    return run;
  }

  async function executionStartedAt(runId: string, ownershipToken: string): Promise<number> {
    return (await store.beginAgentExecution(runId, ownershipToken)).getTime();
  }

  /** Writes the thread's attachments into the workspace; they need object storage to exist. */
  async function materializeThreadAttachments(
    threadAttachments: PiRun["threadAttachments"],
    commandSandbox: CoordinatedSandbox,
    workspace: WorkspaceRecord,
    signal: AbortSignal,
  ): Promise<void> {
    if (threadAttachments.length && !attachmentObjects) throw nonRetryable("INVALID_CONFIGURATION");

    if (attachmentObjects)
      await materializeAttachments(threadAttachments, attachmentObjects, (request) =>
        commandSandbox.exec(workspaceRef(workspace), request, signal),
      );
  }

  /** The approval or question wait a resumed run is still parked on, if any. */
  async function parkedWait(initial: ActiveRun): Promise<RunExecutionResult> {
    if (initial.approvalWaitStartedAt) {
      const operations = await gitStore.forRun(initial.id);
      const last = operations.at(-1);

      if (last)
        return {
          kind: "awaiting_approval",
          operationId: last.id,
          expiresAt: last.expiresAt.getTime(),
        };
    }

    if (initial.questionWaitStartedAt) {
      const request = await store.pendingQuestionRequest(initial.id);

      if (request) return { kind: "awaiting_questions", requestId: request.id };
    }
  }

  /** Takes execution ownership of the workspace and discovers its project instructions and skills. */
  async function claimPiRun(initial: ActiveRun, signal: AbortSignal): Promise<PiRun> {
    const runId = initial.id;
    let workspace = await store.readWorkspace(initial.threadId);

    if (!workspace) throw new Error("Workspace disappeared before Pi execution");
    const attemptId = activityAttemptId();
    const provider = lifecycle.sandboxFor(workspace.provider);
    workspace = await lifecycle.resolveExecutionWorkspace(workspace, provider, signal);

    const { token: ownershipToken } = await store.claimExecutionOwnership({
      runId,
      attemptId,
      generation: workspace.generation,
    });

    const commandSandbox = lifecycle.coordinatedSandbox(provider, runId, attemptId, ownershipToken);

    const threadAttachments = await store.listThreadAttachments(initial.threadId);
    const runAttachments = await store.attachmentsForRun(runId);

    await materializeThreadAttachments(threadAttachments, commandSandbox, workspace, signal);

    const resources = await discoverRemoteResources({
      sandbox: commandSandbox,
      workspace: workspaceRef(workspace),
      signal,
      outputMaxBytes: config.commandOutputMaxBytes,
    });

    await store.appendRunEvent({
      runId,
      ownershipToken,
      type: "skills.discovered",
      payload: {
        skills: resources.skills.flatMap(({ name, description, path }) => {
          const skill = skillMetadataSchema.safeParse({ name, description, path });

          return skill.success ? [skill.data] : [];
        }),
      },
      dedupeKey: `skills:${ownershipToken}`,
    });

    if (resources.diagnostics.length)
      logger.warn({ runId, diagnostics: resources.diagnostics }, "Project skill diagnostics");

    const startedAt = await executionStartedAt(runId, ownershipToken);

    await assertActive(runId, startedAt);

    return {
      initial,
      attemptId,
      provider,
      workspace,
      ownershipToken,
      commandSandbox,
      threadAttachments,
      runAttachments,
      resources,
      startedAt,
    };
  }

  /** A previous attempt already finished the model turn: only completing the run is left. */
  async function completePreviousAttempt(run: PiRun): Promise<boolean> {
    const completed = await store.loadCheckpoint({
      runId: run.initial.id,
      key: "pi-completed",
      generation: run.workspace.generation,
    });

    const completedText = checkpointText(completed);

    if (completedText === undefined) return false;

    await assertActive(run.initial.id, run.startedAt);
    await store.completeRun(run.initial.id, completedText, run.ownershipToken);

    return true;
  }

  /** The Pi session to resume, and the prompt preamble that tells the model what changed. */
  async function restoreSession(run: PiRun) {
    const { initial, workspace } = run;
    const retryCheckpoint = await store.loadCheckpoint({ runId: initial.id, key: "pi-session" });

    const sessionCheckpoint =
      retryCheckpoint ??
      (await store.loadLatestCheckpoint({ threadId: initial.threadId, key: "pi-session" }));

    const sessionGeneration = checkpointGeneration(sessionCheckpoint);

    const replacedFilesystem =
      sessionGeneration !== undefined && sessionGeneration < workspace.generation;

    const parsedSessionMetadata = sessionMetadataFromCheckpoint(sessionCheckpoint);

    const sessionEntries = parsedSessionMetadata
      ? attachmentObjects
        ? await hydrateCheckpointEntries({
            checkpoint: parsedSessionMetadata,
            attachments: run.threadAttachments,
            objects: attachmentObjects,
            userId: initial.userId,
          })
        : decodeLivePiSessionEntries(parsedSessionMetadata.entries)
      : undefined;

    const restoredAttachmentIds = parsedSessionMetadata
      ? checkpointAttachmentIds(parsedSessionMetadata)
      : new Set<string>();

    const resetInstruction = replacedFilesystem ? `${WORKSPACE_RESET_INSTRUCTION}\n\n` : "";

    const continuation = retryCheckpoint
      ? "Continue the interrupted task from the current workspace state.\n\n"
      : "";

    return {
      sessionEntries,
      restoredAttachmentIds,
      preamble: `${resetInstruction}${continuation}`,
    };
  }

  function createRunGitTools(
    run: PiRun,
    repositoryUrl: string | null,
    signal: AbortSignal,
  ): ReturnType<typeof createPiGitTools> | undefined {
    if (!config.gitBroker || !repositoryUrl) return undefined;

    return createPiGitTools({
      client: createGitBrokerClient(
        config.gitBroker,
        {
          runId: run.initial.id,
          generation: run.workspace.generation,
          ownershipToken: run.ownershipToken,
        },
        signal,
      ),
      exec: (request) => run.commandSandbox.exec(workspaceRef(run.workspace), request, signal),
      maxBytes: config.repositoryMaxBytes,
      minFreeBytes: config.repositoryMinFreeBytes,
    });
  }

  /** Prior Git operations with their current outcome, so the model never repeats a finished write. */
  async function collectGitReceipts(
    runId: string,
    git: ReturnType<typeof createPiGitTools> | undefined,
  ): Promise<GitOperation[]> {
    const receipts: GitOperation[] = [];

    if (git) {
      await git.refreshAccess(true);
      await gitStore.expire(runId);

      for (const operation of await gitStore.forRun(runId)) {
        receipts.push(
          operation.approval === "approved" ? await git.receipt(operation.id) : operation,
        );
      }
    }

    return receipts;
  }

  /** OS, shell and branch for the system prompt. A failed probe leaves them unspecified. */
  async function observeEnvironment(
    run: PiRun,
    signal: AbortSignal,
  ): Promise<ObservedEnvironment | undefined> {
    const environmentResult = await run.commandSandbox.exec(
      workspaceRef(run.workspace),
      {
        command:
          'python3 -c \'import json,os,platform,subprocess; p=subprocess.run(["git","-C","/workspace","symbolic-ref","--quiet","--short","HEAD"],capture_output=True,text=True); print(json.dumps({"os":platform.system(),"shell":os.environ.get("SHELL","/bin/sh"),"branch":p.stdout.strip()[:255] if p.returncode==0 else None}))\'',
        timeoutMs: 10_000,
      },
      signal,
    );

    if (
      environmentResult.kind !== "completed" ||
      environmentResult.statusCode !== 0 ||
      environmentResult.outputTruncated
    )
      return undefined;

    try {
      return z
        .object({
          os: z.string().max(256),
          shell: z.string().max(256),
          branch: z.string().max(255).nullable(),
        })
        .safeParse(JSON.parse(environmentResult.stdout)).data;
    } catch {
      /* Failed discovery leaves these facts unspecified. */
      return undefined;
    }
  }

  /**
   * agent-browser reaches the hosted browser only through the gateway relay,
   * with a capability for this thread that outlives the run's idle grace.
   */
  async function configureBrowserRelay(
    run: PiRun,
    remaining: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (!config.browser) return;

    const lease = await lifecycle
      .sandboxFor(run.workspace.provider)
      .resolve(workspaceRef(run.workspace), signal);

    const capability = signRelayCapability(config.browser.relaySecret, {
      threadId: run.initial.threadId,
      generation: run.workspace.generation,
      expires: lease.expiresAt ?? Date.now() + remaining + config.idlePauseMs,
    });

    const written = await run.commandSandbox.exec(
      workspaceRef(run.workspace),
      {
        command: `install -d -m 0700 "$(dirname ${agentBrowserConfigPath})" && umask 077 && cat > ${agentBrowserConfigPath}.tmp && mv ${agentBrowserConfigPath}.tmp ${agentBrowserConfigPath}`,
        stdin: JSON.stringify({ cdp: relayUrl(config.browser.relayUrl, capability) }),
        timeoutMs: 10_000,
      },
      signal,
    );

    if (written.kind !== "completed" || written.statusCode !== 0)
      logger.warn(
        { runId: run.initial.id },
        "Browser relay configuration failed; the browser is unavailable",
      );
  }

  /** Previews route through the gateway to Modal sandboxes only. */
  async function readPreviewTemplate(run: PiRun): Promise<string | undefined> {
    const previewSlug =
      config.previewDomain && run.workspace.provider === "modal"
        ? await store.readPreviewSlug(run.initial.threadId)
        : null;

    return config.previewDomain && previewSlug
      ? previewUrlTemplate(config.previewDomain, previewSlug)
      : undefined;
  }

  /** The user prompt: backend receipts and notes first, then the original request. */
  function executionPrompt(
    run: PiRun,
    receipts: GitOperation[],
    questionReceipts: Awaited<ReturnType<typeof store.listQuestionRequests>>,
    preamble: string,
  ): string {
    return `${receipts.length ? "Backend Git operation receipts. Do not repeat completed operations: " + JSON.stringify(receipts.map((r) => ({ id: r.id, request: r.proposal.request, approval: r.approval, execution: r.execution, result: r.result }))) + "\n\n" : ""}${questionReceipts.length ? "Backend question answer receipts. Continue from the original tool calls: " + JSON.stringify(questionReceipts.map((request) => ({ requestId: request.id, toolCallId: request.toolCallId, questions: request.questions, state: request.state, answers: request.answers }))) + "\n\n" : ""}${preamble}${attachmentManifest(run.runAttachments)}Original request: ${expandRemoteSkill(run.initial.prompt, run.resources)}`;
  }

  /** Records what the Pi run finished with: a wait for a person, or completion. */
  async function settlePiOutput(run: PiRun, output: PiExecutorOutput): Promise<RunExecutionResult> {
    const runId = run.initial.id;

    if (output.approval) {
      const operation = await gitStore.read(output.approval.id);

      return {
        kind: "awaiting_approval",
        operationId: operation.id,
        expiresAt: operation.expiresAt.getTime(),
      };
    }

    if (output.questionRequest)
      return { kind: "awaiting_questions", requestId: output.questionRequest.id };

    await assertActive(runId, run.startedAt);
    await store.saveCheckpoint({
      runId,
      key: "pi-completed",
      generation: run.workspace.generation,
      attemptId: run.attemptId,
      ownershipToken: run.ownershipToken,
      content: {
        version: 1,
        kind: "pi.completed",
        generation: run.workspace.generation,
        attemptId: run.attemptId,
        text: output.text,
      },
    });
    await store.completeRun(runId, output.text, run.ownershipToken);
  }

  async function runPiLocked(runId: string, signal: AbortSignal): Promise<RunExecutionResult> {
    const initial = await store.loadRun(runId);

    if (!runIsActive(initial)) return;

    const parked = await parkedWait(initial);

    if (parked) return parked;

    const run = await claimPiRun(initial, signal);
    const { attemptId, workspace, ownershipToken, commandSandbox } = run;

    if (await completePreviousAttempt(run)) return;

    const session = await restoreSession(run);
    const remaining = Math.max(1, config.maxRunMs - gitExecutionElapsed(initial));
    const executionSignal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);

    const repository = await store.readRepository({
      userId: initial.userId,
      threadId: initial.threadId,
    });

    const git = createRunGitTools(run, repository.repositoryUrl, executionSignal);
    const receipts = await collectGitReceipts(runId, git);

    const questionReceipts = (
      await store.listQuestionRequests({
        userId: initial.userId,
        threadId: initial.threadId,
      })
    ).filter((request) => request.runId === runId && request.state !== "pending");

    const questions = createPiQuestionTools({ browser: Boolean(config.browser) });

    const webTools = createWebTools({
      braveApiKey: config.braveSearchApiKey,
      firecrawlApiKey: config.firecrawlApiKey,
    });

    const observed = await observeEnvironment(run, executionSignal);

    const diffStat = createDiffStatRefresher({
      read: () =>
        readDiffStat(
          run.provider,
          workspaceRef(workspace),
          repository.repositoryBranch,
          executionSignal,
        ),
      publish: (stat) =>
        store.recordDiffStat({
          threadId: initial.threadId,
          generation: workspace.generation,
          stat,
        }),
      logger,
    });

    // Counts the files as the run finds them, so a thread without a count gets one.
    diffStat.refresh();

    const event = async (piEvent: PiEvent) => {
      const scoped = scopePiAttemptEvent(runId, attemptId, piEvent);
      await store.appendRunEvent({
        runId,
        ownershipToken,
        type: scoped.type,
        payload: scoped.payload,
        dedupeKey: scoped.dedupeKey,
      });

      if (
        piEvent.type === "tool.completed" &&
        ["bash", "edit", "write"].includes(String(piEvent.payload.name))
      )
        diffStat.refresh();
    };

    const { selection, credentials } = await requireModelCredentials(ctx, initial);

    const images = attachmentObjects
      ? await promptImages(
          run.runAttachments.filter((item) => !session.restoredAttachmentIds.has(item.id)),
          attachmentObjects,
        )
      : [];

    const checkpointImages = attachmentImageReferences(run.threadAttachments);

    await configureBrowserRelay(run, remaining, executionSignal);

    const previewTemplate = await readPreviewTemplate(run);

    const executePi = createPiExecutor({
      git,
      questions,
      webTools,
      environment: {
        repositoryUrl: repository.repositoryUrl,
        branch: observed?.branch ?? null,
        os: observed?.os,
        shell: observed?.shell,
        executionLimitMs: remaining,
        repositoryMaxBytes: config.repositoryMaxBytes,
        repositoryMinFreeBytes: config.repositoryMinFreeBytes,
        checkpointMaxBytes: config.checkpointMaxBytes,
        previewUrlTemplate: previewTemplate,
        browser: config.browser ? "hosted" : undefined,
      },
      // The forwarder presents preview hostnames as Host, so Vite must allow them.
      guestEnvironment: previewTemplate
        ? {
            PREVIEW_URL_TEMPLATE: previewTemplate,
            __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: `.${config.previewDomain}`,
          }
        : undefined,
      resources: run.resources,
      // The sandbox adapter is coordinator-backed and never invokes
      // provider.exec itself.
      sandbox: commandSandbox,
      workspace: workspaceRef(workspace),
      piProvider: selection.provider,
      piModel: selection.model,
      thinkingLevel: selection.thinkingLevel,
      credentials,
      emit: event,
      checkpoint: async (metadata, gitProposal, questionRequest) => {
        await store.saveCheckpoint({
          runId,
          key: "pi-session",
          gitProposal,
          questionRequest,
          ownershipToken,
          generation: workspace.generation,
          attemptId,
          content: {
            kind: "pi",
            ...metadata,
            generation: workspace.generation,
            attemptId,
          },
        });
      },
      logger,
    });

    let output;

    try {
      output = await executePi({
        prompt: executionPrompt(run, receipts, questionReceipts, session.preamble),
        runId,
        attemptId,
        workspaceGeneration: workspace.generation,
        outputMaxBytes: config.commandOutputMaxBytes,
        checkpointMaxBytes: config.checkpointMaxBytes,
        signal: executionSignal,
        sessionEntries: session.sessionEntries,
        images,
        checkpointImages,
        workspace: workspaceRef(workspace),
      });
    } catch (error) {
      if (
        error instanceof PiCheckpointLimitError ||
        error instanceof PiCheckpointSerializationError
      )
        throw nonRetryable("CHECKPOINT_TOO_LARGE");
      await assertActive(runId, run.startedAt);
      throw error;
    }

    // The last mutating tool's count must land before the run turns terminal.
    await diffStat.settled();

    return settlePiOutput(run, output);
  }

  async function runScriptedLocked(runId: string, signal: AbortSignal): Promise<void> {
    const initial = await store.loadRun(runId);

    if (!runIsActive(initial)) return;
    let workspaceRecord = await store.readWorkspace(initial.threadId);

    if (!workspaceRecord) throw new Error("Workspace disappeared before scripted execution");
    const attemptId = activityAttemptId();
    const provider = lifecycle.sandboxFor(workspaceRecord.provider);
    workspaceRecord = await lifecycle.resolveExecutionWorkspace(workspaceRecord, provider, signal);

    const { token: ownershipToken } = await store.claimExecutionOwnership({
      runId,
      attemptId,
      generation: workspaceRecord.generation,
    });

    const startedAt = await executionStartedAt(runId, ownershipToken);

    await assertActive(runId, startedAt);
    const commandSandbox = lifecycle.coordinatedSandbox(provider, runId, attemptId, ownershipToken);
    const threadAttachments = await store.listThreadAttachments(initial.threadId);

    await materializeThreadAttachments(threadAttachments, commandSandbox, workspaceRecord, signal);

    const result = await executeScripted({
      runId,
      prompt: initial.prompt,
      workspace: workspaceRef(workspaceRecord),
      stepDelayMs: config.stepDelayMs,
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.max(1, config.maxRunMs - (Date.now() - startedAt))),
      ]),
      execute: (workspace, request, commandSignal) =>
        commandSandbox.exec(workspace, request, commandSignal),
      emit: async (scriptedEvent) => {
        const scoped = scopeScriptedAttemptEvent(runId, attemptId, scriptedEvent);
        await store.appendRunEvent({
          runId,
          ownershipToken,
          type: scoped.type,
          payload: scoped.payload,
          dedupeKey: scoped.dedupeKey,
        });
      },
      checkpoint: {
        load: async (key) => {
          const saved = await store.loadCheckpoint({
            runId,
            key,
            generation: workspaceRecord.generation,
          });

          return scriptedCheckpointSchema.safeParse(saved?.content).data;
        },
        save: async (key, content) => {
          await store.saveCheckpoint({
            runId,
            key,
            generation: workspaceRecord.generation,
            attemptId,
            ownershipToken,
            content: { ...content, generation: workspaceRecord.generation, attemptId },
          });
        },
      },
    });

    await assertActive(runId, startedAt);
    await store.completeRun(runId, result, ownershipToken);
  }

  const executeRun = Effect.fnUntraced(function* (runId: string, execute: typeof runPiLocked) {
    const initial = yield* Effect.tryPromise({
      try: () => store.loadRun(runId),
      catch: (error) => error,
    });

    if (!runIsActive(initial)) return;

    return yield* lifecycle
      .withThreadWorkspaceLock(initial.threadId, (signal) => execute(runId, signal))
      .pipe(Effect.catch((error) => lifecycle.recoverAttempt(initial.threadId, error)));
  });

  const runPi = (runId: string) => executeRun(runId, runPiLocked);
  const runScripted = (runId: string) => executeRun(runId, runScriptedLocked);

  const runExecution = (runId: string) =>
    config.executionMode === "pi" ? runPi(runId) : runScripted(runId);

  async function finalizeRun(
    runId: string,
    status: "failed" | "cancelled",
    error?: string,
    failureCode?: string,
  ): Promise<void> {
    const current = await store.loadRun(runId);

    if (!current || !runIsActive(current)) return;

    if (status === "cancelled" || current.cancelRequestedAt) await store.cancelRun(runId);
    else {
      const deadlineReached =
        current.agentStartedAt !== null && gitExecutionElapsed(current) >= config.maxRunMs;

      const message = deadlineReached
        ? publicFailureForCode("RUN_TIMEOUT").message
        : publicFailureMessage(error ?? "Agent execution failed");

      await store.failRun(runId, message, deadlineReached ? "RUN_TIMEOUT" : failureCode);
    }
  }

  return { runPi, runScripted, runExecution, finalizeRun };
}
