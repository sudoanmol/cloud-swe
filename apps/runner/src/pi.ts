import { piSystemPrompt, type PiEnvironment } from "./pi-system-prompt.js";
import type { PiGitTools } from "./git-tools.js";
import type { GitProposal } from "@cloud-swe/db/git-contracts";
import type { QuestionRequestPayload } from "@cloud-swe/db/question-contracts";
import type { PiQuestionTools } from "./question-tools.js";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { quoteShell } from "./text.js";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type FileEntry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { expandRemoteSkill, type RemoteResources } from "./remote-resources.js";

import { Deferred, Effect } from "effect";
import type { Logger } from "pino";
import type { PiAttachmentImageReference } from "@cloud-swe/db/checkpoint";
import type { JsonObject } from "@cloud-swe/db/json";
import { publicFailureMessage } from "@cloud-swe/db/public-failure";
import { ThreadStoreError } from "@cloud-swe/db/thread-contracts";
import {
  piOperation,
  PI_WRITER_DEFAULT_CLEANUP_TIMEOUT_MS,
  PiPersistenceWriter,
  type Awaitable,
  type PiWriterCompletionOptions,
} from "./pi-persistence.js";
import { UnresolvedCommandError } from "./execution-coordinator.js";
import {
  assertPiCheckpointSize,
  referenceCheckpointImages,
  serializedPiCheckpointBytes,
  type PiPersistedSessionMetadata,
  type PiSessionMetadata,
} from "./pi-checkpoint.js";
import {
  commandPayload,
  defaultOutputMaxBytes,
  fingerprint,
  normalizePiCommandResult,
  PiToolExecutionError,
  positiveInteger,
  transportFromThrownError,
  type PiCommandDiagnostic,
} from "./pi-command.js";
import {
  createPiEventProjector,
  piAttemptEventIdentity,
  type PiEvent,
  type PiEventType,
} from "./pi-events.js";
import {
  createPiResourceLoader,
  createPiSession,
  disposePiSession,
  injectedPiModel,
  resolvePiModel,
  textFromMessages,
  type PiSessionFactory,
  type PiSessionLike,
} from "./pi-session.js";
import { createRemoteTools } from "./pi-tools.js";
import type {
  CommandProgressObserver,
  CommandRequest,
  SandboxProvider,
  WorkspaceRef,
} from "./sandbox.js";

const workspaceRoot = "/workspace";

const defaultCheckpointMaxBytes = 4_194_304;

type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface PiAttemptOptions {
  /** Activity-attempt identity. Retries must supply a new value. */
  attemptId: string;
  /** Filesystem generation used by this Pi attempt. */
  workspaceGeneration: number;
  /** Shared stdout/stderr byte limit for remote tools. */
  outputMaxBytes: number;
  /** Maximum serialized resumable-session checkpoint size. */
  checkpointMaxBytes: number;
}

export interface PiExecutorConfig {
  git?: PiGitTools;
  questions?: PiQuestionTools;
  webTools?: ToolDefinition[];
  environment?: PiEnvironment;
  /** Exported into every bash call; values are backend-supplied, never secrets. */
  guestEnvironment?: Record<string, string>;
  resources?: RemoteResources;
  sandbox: Pick<SandboxProvider, "exec">;
  workspace: WorkspaceRef;
  /** Provider persisted with the run. */
  piProvider?: string;
  /** Model persisted with the run. */
  piModel?: string;
  thinkingLevel?: PiThinkingLevel;
  credentials?: CredentialStore;
  /** Worker-level default for the shared stdout/stderr byte limit. */
  outputMaxBytes?: number;
  /** Worker-level default for the serialized resumable-session checkpoint size. */
  checkpointMaxBytes?: number;
  /** Cleanup budget for persistence acknowledgements and session aborts. */
  persistenceCleanupTimeoutMs?: number;
  emit: (event: PiEvent) => Awaitable<void>;
  /** Persists the resumable session checkpoint, not the completion checkpoint. */
  checkpoint?: (
    metadata: PiPersistedSessionMetadata,
    proposal?: GitProposal,
    questionRequest?: QuestionRequestPayload,
  ) => Awaitable<void>;
  /** Structured logger for secondary cleanup diagnostics. */
  logger?: Pick<Logger, "warn">;
}

export interface PiExecutorInput {
  prompt: string;
  signal?: AbortSignal;
  runId: string;
  /** Activity-attempt identity. Every retry supplies a new value. */
  attemptId: string;
  /** Workspace generation observed by the activity owner. */
  workspaceGeneration: number;
  /** Per-attempt limit overrides supplied by the activity owner. */
  outputMaxBytes?: number;
  checkpointMaxBytes?: number;
  sessionEntries?: FileEntry[];
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  checkpointImages?: PiAttachmentImageReference[];
  workspace?: WorkspaceRef;
}

export interface PiExecutorOutput {
  approval?: GitProposal;
  questionRequest?: QuestionRequestPayload;
  text: string;
  session: PiPersistedSessionMetadata;
}

// oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON payloads are already validated at their event boundary.
function deepFreeze<T>(value: T): T {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The event payload is a validated JSON object.
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;

  for (const child of Object.values(value)) deepFreeze(child);

  return Object.freeze(value);
}

/**
 * Dependency seam for deterministic executor tests. The worker uses the
 * published SDK factory when this is omitted; it does not provide a production
 * alternate session implementation.
 */
export interface PiExecutorDependencies {
  createAgentSession?: PiSessionFactory;
}

function resolvePiAttemptOptions(
  config: PiExecutorConfig,
  input: PiExecutorInput,
  workspace: WorkspaceRef,
): PiAttemptOptions {
  if (!input.attemptId) throw new Error("Pi attemptId is required");

  return {
    attemptId: input.attemptId,
    workspaceGeneration: input.workspaceGeneration ?? workspace.generation,
    outputMaxBytes: positiveInteger(
      input.outputMaxBytes ?? config.outputMaxBytes,
      "outputMaxBytes",
      defaultOutputMaxBytes,
    ),
    checkpointMaxBytes: positiveInteger(
      input.checkpointMaxBytes ?? config.checkpointMaxBytes,
      "checkpointMaxBytes",
      defaultCheckpointMaxBytes,
    ),
  };
}

export function createPiExecutor(
  config: PiExecutorConfig,
  dependencies: PiExecutorDependencies = {},
) {
  const guestExports = Object.entries(config.guestEnvironment ?? {})
    .map(([name, value]) => `export ${name}=${quoteShell(value)} && `)
    .join("");

  return async function execute(input: PiExecutorInput): Promise<PiExecutorOutput> {
    const signal = input.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const workspace = input.workspace ?? config.workspace;
    const attempt = resolvePiAttemptOptions(config, input, workspace);

    const persistenceCleanupTimeoutMs = positiveInteger(
      config.persistenceCleanupTimeoutMs,
      "persistenceCleanupTimeoutMs",
      PI_WRITER_DEFAULT_CLEANUP_TIMEOUT_MS,
    );

    const injectedSessionFactory = dependencies.createAgentSession;

    const { runtime, model, modelProvider, modelIdentifier } = injectedSessionFactory
      ? injectedPiModel(config)
      : await resolvePiModel(config);

    const sessionManager = input.sessionEntries
      ? SessionManager.inMemory(workspaceRoot, undefined, input.sessionEntries)
      : SessionManager.inMemory(workspaceRoot);

    const settingsManager = SettingsManager.inMemory({
      defaultTools: [],
      compaction: { enabled: false },
      retry: { enabled: false },
    });

    const toolOutcomes = new Map<string, PiCommandDiagnostic>();
    let session: PiSessionLike;
    let writer: PiPersistenceWriter;
    let writerCleanupStarted = false;

    let completeWriter: (options?: PiWriterCompletionOptions) => Promise<void>;

    const persistenceFailure = Deferred.makeUnsafe<never, unknown>();
    let abortOperation: Promise<void> | undefined;

    const abortSession = (): Promise<void> => {
      if (!abortOperation) {
        abortOperation = (async () => {
          try {
            await session.abort();
          } catch {
            // The caller's failure remains authoritative if abort itself fails.
          }
        })();
      }

      return abortOperation;
    };

    let latchedTransportError: PiToolExecutionError | UnresolvedCommandError | undefined;

    const latchTransportError = (
      outcome: PiCommandDiagnostic,
      failure?: UnresolvedCommandError,
    ) => {
      if (!latchedTransportError) {
        latchedTransportError = failure ?? new PiToolExecutionError(outcome);
        void abortSession();
      }

      return latchedTransportError;
    };

    const eventIdentity = piAttemptEventIdentity(input.runId, attempt.attemptId);

    const withMetadata = (payload: JsonObject): JsonObject => ({
      ...payload,
      runId: input.runId,
      attemptId: attempt.attemptId,
    });

    const writeEvent = (
      type: PiEventType,
      dedupeKey: string,
      payload: JsonObject,
    ): Promise<void> => {
      const event = {
        type,
        dedupeKey,
        payload: withMetadata(payload),
      } satisfies PiEvent;

      const sizeBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
      const captured = deepFreeze(event);

      return writer.enqueue(() => config.emit(captured), {
        kind: "event",
        sizeBytes,
      });
    };

    const queueEvent = (type: PiEventType, dedupeKey: string, payload: JsonObject): void => {
      void writeEvent(type, dedupeKey, payload).catch(() => undefined);
    };

    const projector = createPiEventProjector({
      runId: input.runId,
      attemptId: attempt.attemptId,
      outputMaxBytes: attempt.outputMaxBytes,
      queueEvent,
      toolOutcomes,
    });

    const remoteExec = async (
      command: string,
      toolCallId: string,
      toolSignal: AbortSignal | undefined,
      stdin?: string,
      access: "read" | "exclusive" = "exclusive",
      liveOutput = false,
      timeoutMs?: number,
    ): Promise<PiCommandDiagnostic> => {
      const effectiveSignal = toolSignal ? AbortSignal.any([toolSignal, signal]) : signal;

      if (config.git?.pending()) throw new Error("Not executed: waiting for Git approval.");

      if (config.questions?.pending()) throw new Error("Not executed: waiting for answers.");
      await config.git?.refreshAccess();

      // Only the user-facing shell tool publishes live output. Repository setup,
      // attachments, discovery and file tools stay silent.
      const progress: CommandProgressObserver | undefined = liveOutput
        ? (update) => {
            if (update.type === "unavailable") {
              queueEvent("tool.output", `${eventIdentity}:tool:${toolCallId}:live-unavailable`, {
                toolCallId,
                diagnostic: update.reason,
                partial: true,
              });

              return;
            }

            queueEvent(
              "tool.output",
              `${eventIdentity}:tool:${toolCallId}:live:${update.stream}:${update.offset}:${update.nextOffset}`,
              {
                toolCallId,
                incremental: true,
                commandId: update.commandId,
                callId: toolCallId,
                stream: update.stream,
                offset: update.offset,
                bytes: update.bytes,
                nextOffset: update.nextOffset,
                text: update.text,
              },
            );
          }
        : undefined;

      const request: CommandRequest = {
        command: `cd ${workspaceRoot} && ${config.git ? "export GIT_CONFIG_GLOBAL=/var/lib/cloud-swe/git.config && " : ""}${guestExports}${command}`,
        stdin,
        access,
      };

      if (timeoutMs !== undefined) request.timeoutMs = timeoutMs;

      if (progress) request.progress = progress;

      let outcome: PiCommandDiagnostic;
      let coordinatorFailure: UnresolvedCommandError | undefined;

      try {
        effectiveSignal.throwIfAborted();
        const result = await config.sandbox.exec(workspace, request, effectiveSignal);
        outcome = normalizePiCommandResult(result, attempt.outputMaxBytes);
      } catch (error) {
        if (error instanceof UnresolvedCommandError) coordinatorFailure = error;
        outcome = transportFromThrownError(error, effectiveSignal, attempt.outputMaxBytes);
      }

      // Persist the complete bounded diagnostic before classifying the command
      // as a process result or a coordinator/transport failure.
      toolOutcomes.set(toolCallId, outcome);
      const outputIndex = projector.nextToolOutputIndex();

      const outputWrite = writeEvent(
        "tool.output",
        `${eventIdentity}:tool:${toolCallId}:output:${outputIndex}:${fingerprint(outcome.output)}`,
        {
          toolCallId,
          ...commandPayload(outcome),
        },
      );

      const isUnsettledTransport =
        outcome.kind === "transport-timeout" ||
        outcome.kind === "cancelled" ||
        outcome.kind === "unknown";

      const fatalError = isUnsettledTransport
        ? latchTransportError(outcome, coordinatorFailure)
        : undefined;

      await outputWrite;

      // A bounded output result is known-settled and may remain a tool error;
      // coordinator timeout/cancel/unknown outcomes are not. The latter must
      // remain fatal even if Pi swallows the tool exception and writes a final
      // textual answer.
      if (fatalError) throw fatalError;

      if (outcome.kind === "output-limit") throw new PiToolExecutionError(outcome);

      return outcome;
    };

    const tools: ToolDefinition[] = [
      ...createRemoteTools(remoteExec, attempt.outputMaxBytes),
      ...(config.git?.tools ?? []),
      ...(config.questions?.tools ?? []),
      ...(config.webTools ?? []),
    ];

    const resourceLoader = createPiResourceLoader(
      config.resources,
      piSystemPrompt(
        workspace,
        tools.map((tool) => tool.name),
        attempt.outputMaxBytes,
        config.environment,
      ),
    );

    const pendingWait = () => config.git?.pending() ?? config.questions?.pending();

    for (const tool of tools) {
      const execute = tool.execute;
      tool.execute = async (...args) => {
        const pending = pendingWait();

        if (pending)
          return {
            content: [
              {
                type: "text",
                text: config.git?.pending()
                  ? "Not executed: waiting for the pending Git approval."
                  : "Not executed: waiting for the pending answers.",
              },
            ],
            details: { skipped: true },
            terminate: true,
          };

        try {
          return await execute(...args);
        } catch (error) {
          if (error instanceof UnresolvedCommandError)
            throw latchTransportError(
              transportFromThrownError(error, signal, attempt.outputMaxBytes),
              error,
            );
          throw error;
        }
      };
    }

    const createSession = injectedSessionFactory ?? createAgentSession;

    const acquireSession = () =>
      createPiSession(
        createSession,
        {
          cwd: workspaceRoot,
          modelRuntime: runtime,
          model,
          thinkingLevel: config.thinkingLevel ?? "medium",
          noTools: "all",
          tools: tools.map((tool) => tool.name),
          customTools: tools,
          resourceLoader,
          sessionManager,
          settingsManager,
        },
        signal,
      );

    let subscribed = false;

    let unsubscribeRaw: (() => void) | undefined;

    let unsubscribe: (() => void) | undefined;

    const onAbort = (): void => {
      void abortSession();
    };

    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const created = yield* Effect.acquireRelease(piOperation(acquireSession), (created) =>
            Effect.promise(() => disposePiSession(created.session, config.logger)),
          );

          session = created.session;

          if ((config.git || config.questions) && session.agent) {
            const previous = session.agent.finishTurn;
            session.agent.finishTurn = async (turn, signal) =>
              pendingWait() ? { action: "end" } : ((await previous?.(turn, signal)) ?? undefined);
          }

          // The persistence consumer belongs to the acquired Pi session. Construct
          // it only after session creation succeeds so a rejected/cancelled factory
          // cannot leave a detached consumer fiber behind.
          writer = yield* Effect.acquireRelease(
            Effect.sync(
              () =>
                new PiPersistenceWriter({
                  cleanupTimeoutMs: persistenceCleanupTimeoutMs,
                  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the first persistence failure for attempt-level precedence.
                  onFailure: (error) => {
                    Deferred.doneUnsafe(persistenceFailure, Effect.fail(error));

                    return abortSession();
                  },
                }),
            ),
            () => piOperation(() => completeWriter()).pipe(Effect.catch(() => Effect.void)),
          );
          completeWriter = async (options = {}) => {
            if (writerCleanupStarted) return;

            writerCleanupStarted = true;
            await writer.complete(options);
          };

          const captureSessionMetadata = (): PiSessionMetadata => {
            const header = sessionManager.getHeader();

            if (!header) throw new Error("Pi session is missing its header");

            return {
              sessionId: session.sessionId,
              provider: modelProvider,
              model: modelIdentifier,
              entries: [
                header,
                ...sessionManager.getEntries().map((entry) => {
                  if (entry.type !== "message" || entry.message.role !== "assistant") return entry;
                  // Provider diagnostics and error bodies can contain request credentials.
                  const { diagnostics: _diagnostics, ...message } = entry.message;

                  return {
                    ...entry,
                    message: {
                      ...message,
                      errorMessage: message.errorMessage
                        ? publicFailureMessage(message.errorMessage)
                        : undefined,
                    },
                  };
                }),
              ],
              runId: input.runId,
              attemptId: attempt.attemptId,
              workspaceGeneration: attempt.workspaceGeneration,
              assistantAttempt: projector.assistantAttempt(),
            };
          };

          const awaitCommit = (acknowledgement: Promise<void>): Promise<void> =>
            Effect.runPromise(
              Effect.raceFirst(
                piOperation(() => acknowledgement, {
                  signal,
                  timeoutMs: persistenceCleanupTimeoutMs,
                }),
                Deferred.await(persistenceFailure),
              ),
            );

          const awaitPrompt = (): Promise<void> =>
            Effect.runPromise(
              Effect.raceFirst(
                piOperation(
                  () =>
                    session.prompt(
                      config.resources
                        ? expandRemoteSkill(input.prompt, config.resources)
                        : input.prompt,
                      {
                        expandPromptTemplates: false,
                        images: input.images?.length ? input.images : undefined,
                      },
                    ),
                  { signal },
                ),
                Deferred.await(persistenceFailure),
              ),
            );

          const persistSession = async (): Promise<PiPersistedSessionMetadata> => {
            try {
              const metadata = referenceCheckpointImages(
                captureSessionMetadata(),
                input.checkpointImages ?? [],
              );

              if (!config.checkpoint) return metadata;

              const estimatedSizeBytes = serializedPiCheckpointBytes(metadata);

              assertPiCheckpointSize(metadata, attempt.checkpointMaxBytes);

              // Admission must happen before decoding, sanitizing, or cloning the
              // complete transcript. This check is synchronous with the following
              // enqueue, so no other producer can race the retained-byte budget.
              writer.preflight(estimatedSizeBytes);

              const decoded = metadata;

              const normalizedMetadata: PiPersistedSessionMetadata = {
                ...decoded,
                runId: input.runId,
                attemptId: attempt.attemptId,
                workspaceGeneration: attempt.workspaceGeneration,
                assistantAttempt: projector.assistantAttempt(),
              };

              const sizeBytes = serializedPiCheckpointBytes(normalizedMetadata);

              assertPiCheckpointSize(normalizedMetadata, attempt.checkpointMaxBytes);

              // The shared Zod decoder returns a deep snapshot before the writer
              // waits behind earlier event writes. A later turn cannot enlarge it.
              const captured = normalizedMetadata;
              const capturedProposal = config.git?.pending();
              const capturedQuestionRequest = config.questions?.pending();

              await awaitCommit(
                writer.enqueue(
                  async () => {
                    await config.checkpoint?.(captured, capturedProposal, capturedQuestionRequest);
                  },
                  {
                    kind: "checkpoint",
                    sizeBytes,
                  },
                ),
              );

              return normalizedMetadata;
            } catch (error) {
              if (!writer.failed && !signal.aborted) writer.fail(error);

              throw error;
            }
          };

          const queueCheckpoint = (): void => {
            void persistSession().catch(() => undefined);
          };

          // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Rethrow the original failure after draining persistence and aborting the SDK session.
          const throwAfterDrain = async (fallbackError: unknown): Promise<never> => {
            const deadline = Date.now() + persistenceCleanupTimeoutMs;

            // Stop producer admission before waiting on SDK or persistence
            // cleanup. Late SDK callbacks are ignored by the subscription guard.
            unsubscribe?.();
            writer.close();

            try {
              await Effect.runPromise(
                piOperation(abortSession, { timeoutMs: Math.max(1, deadline - Date.now()) }),
              );
            } catch {
              // Cleanup is bounded and secondary. The persistence failure, if any,
              // remains authoritative below.
            }

            try {
              await completeWriter({ timeoutMs: Math.max(1, deadline - Date.now()) });
            } catch (error) {
              if (writer.failure?.error !== undefined) throw writer.failure.error;

              // A producer failure remains authoritative over a secondary cleanup
              // timeout or cancellation.
              if (latchedTransportError) throw latchedTransportError;
              throw fallbackError ?? error;
            }

            if (writer.failure?.error !== undefined) throw writer.failure.error;

            if (latchedTransportError) throw latchedTransportError;
            throw fallbackError;
          };

          yield* Effect.acquireRelease(
            Effect.try({
              try: () => {
                subscribed = true;
                unsubscribe = session.subscribe((event: AgentSessionEvent) => {
                  if (!subscribed) return;

                  projector.handle(event);

                  // Pi appends all message entries before turn_end. A turn boundary is the
                  // minimum durable session save; entry_appended and agent_end are not save
                  // triggers, avoiding a full-array rewrite for every transcript entry.
                  if (event.type === "turn_end") {
                    queueCheckpoint();

                    if (pendingWait() && !session.agent) void abortSession();
                  }
                });
                unsubscribeRaw = unsubscribe;
                unsubscribe = () => {
                  if (!subscribed) return;

                  projector.flushDelta();
                  subscribed = false;
                  unsubscribeRaw?.();
                };

                signal.addEventListener("abort", onAbort, { once: true });
              },
              catch: (error) => error,
            }),
            () =>
              Effect.sync(() => {
                signal.removeEventListener("abort", onAbort);
                unsubscribe?.();
              }),
          );

          return yield* piOperation(async () => {
            try {
              await persistSession();
              signal.throwIfAborted();
              await awaitPrompt();
              projector.flushDelta();
              signal.throwIfAborted();

              if (latchedTransportError) await throwAfterDrain(latchedTransportError);
              await writer.drain({ timeoutMs: persistenceCleanupTimeoutMs });

              if (latchedTransportError) await throwAfterDrain(latchedTransportError);

              const approval = config.git?.pending();
              const questionRequest = config.questions?.pending();

              if (approval || questionRequest) {
                unsubscribe?.();
                const metadata = await persistSession();
                await completeWriter({ timeoutMs: persistenceCleanupTimeoutMs });

                return {
                  text: approval ? "Waiting for Git approval." : "Waiting for answers.",
                  session: metadata,
                  approval,
                  questionRequest,
                };
              }

              const assistant = [...session.messages]
                .reverse()
                .find((message) => message.role === "assistant");

              if (!assistant) throw new Error("Pi completed without an assistant response");

              if (assistant.stopReason === "error" || assistant.stopReason === "aborted")
                throw new ThreadStoreError(
                  "MODEL_SERVICE_FAILED",
                  "The model service could not complete this task.",
                );
              const text = textFromMessages(session);

              if (!text.trim())
                throw new Error("Pi completed without a textual assistant response");

              unsubscribe?.();
              const metadata = await persistSession();
              await completeWriter({ timeoutMs: persistenceCleanupTimeoutMs });

              return { text, session: metadata };
            } catch (error) {
              await throwAfterDrain(error);
              // throwAfterDrain always throws; rethrow to satisfy the executor's
              // PiExecutorOutput return contract on every code path.
              throw error;
            }
          });
        }),
      ),
    );
  };
}
