import { expect, test } from "bun:test";
import { z } from "zod";
import {
  assistantStartedDedupeKey,
  createPiExecutor,
  type PiExecutorDependencies,
  type PiPersistedSessionMetadata,
  type PiEvent,
} from "../src/pi.js";
import { processResult } from "../src/sandbox.js";
import { Type } from "typebox";
import type { ToolCall } from "@earendil-works/pi-ai";
import { createPiGitTools, type PiGitTools } from "../src/git-tools.js";
import { UnresolvedCommandError } from "../src/execution-coordinator.js";
import { proposalDigest, type GitProposal } from "@cloud-swe/db/git-contracts";
import { jsonValueSchema } from "@cloud-swe/db/json";
import type { QuestionRequestPayload } from "@cloud-swe/db/question-contracts";
import { createPiQuestionTools, type PiQuestionTools } from "../src/question-tools.js";

type Factory = NonNullable<PiExecutorDependencies["createAgentSession"]>;

type Session = Awaited<ReturnType<Factory>>["session"];

type Manager = NonNullable<Parameters<Factory>[0]["sessionManager"]>;

type Subscriber = Parameters<Session["subscribe"]>[0];

// SAFETY: The tools and hook in the question-boundary fixture ignore their context argument.
const emptyExtensionContext = {} as never;

const assistant = {
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  stopReason: "stop",
  api: "anthropic-messages",
  provider: "anthropic",
  model: "test",
  timestamp: 1,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
} satisfies Session["messages"][number];

function fixture(hooks: {
  prompt: (manager: Manager, emit: Subscriber, options: Parameters<Factory>[0]) => Promise<void>;
  agent?: Session["agent"];
  onCommand?: () => void;
  sandboxExec?: (request: {
    command: string;
    stdin?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
  }) => ReturnType<typeof processResult>;
  emit?: (event: PiEvent) => Promise<void>;
  checkpoint?: (metadata: PiPersistedSessionMetadata) => Promise<void>;
  unsubscribe?: (emit: Subscriber) => void;
  subscribeFailure?: Error;
  abort?: () => Promise<void>;
  git?: PiGitTools;
  questions?: PiQuestionTools;
  guestEnvironment?: Record<string, string>;
  proposalCheckpoint?: (
    metadata: PiPersistedSessionMetadata,
    proposal?: GitProposal,
  ) => Promise<void>;
  questionCheckpoint?: (
    metadata: PiPersistedSessionMetadata,
    request?: QuestionRequestPayload,
  ) => Promise<void>;
}) {
  const calls: string[] = [];
  const checkpoints: PiPersistedSessionMetadata[] = [];
  let disposed = 0;

  const factory: Factory = async (options) => {
    const manager = options.sessionManager;
    const header = manager?.getHeader();

    if (!manager || !header) throw new Error("Expected an SDK session manager");
    let subscriber: Subscriber = () => {};

    return {
      session: {
        agent: hooks.agent,
        sessionId: header.id,
        messages: [assistant],
        subscribe: (listen) => {
          if (hooks.subscribeFailure) throw hooks.subscribeFailure;
          subscriber = listen;

          return () => {
            calls.push("unsubscribe");
            hooks.unsubscribe?.(subscriber);
          };
        },
        prompt: async () => {
          await hooks.prompt(manager, subscriber, options);
          calls.push("prompt-settled");
        },
        abort: async () => {
          calls.push("abort");
          await hooks.abort?.();
        },
        dispose: () => {
          disposed++;
          calls.push("dispose");
        },
      },
    };
  };

  const execute = createPiExecutor(
    {
      git: hooks.git,
      questions: hooks.questions,
      guestEnvironment: hooks.guestEnvironment,
      workspace: {
        id: "workspace",
        threadId: "thread",
        name: "test",
        provider: "docker",
        providerId: null,
        generation: 1,
      },
      sandbox: {
        exec: async (_workspace, request) => {
          hooks.onCommand?.();

          return hooks.sandboxExec?.(request) ?? processResult("", "", 0);
        },
      },
      emit: async (event) => {
        calls.push("event");
        await hooks.emit?.(event);
      },
      checkpoint: async (metadata, proposal, questionRequest) => {
        calls.push("checkpoint");
        checkpoints.push(metadata);
        await hooks.checkpoint?.(metadata);
        await hooks.proposalCheckpoint?.(metadata, proposal);
        await hooks.questionCheckpoint?.(metadata, questionRequest);
      },
    },
    { createAgentSession: factory },
  );

  return {
    calls,
    checkpoints,
    disposed: () => disposed,
    run: (signal?: AbortSignal) =>
      execute({
        prompt: "test",
        runId: "run",
        attemptId: "attempt",
        workspaceGeneration: 1,
        signal,
      }),
  };
}

test("question checkpoints stop Pi at the tool boundary", async () => {
  const questions = createPiQuestionTools();
  const saved: Array<QuestionRequestPayload | undefined> = [];
  let commands = 0;
  const agent: NonNullable<Session["agent"]> = {};

  const harness = fixture({
    questions,
    agent,
    onCommand: () => {
      commands += 1;
    },
    questionCheckpoint: async (_metadata, request) => {
      saved.push(request);
    },
    prompt: async (manager, emit, options) => {
      const calls: ToolCall[] = [
        {
          type: "toolCall" as const,
          id: "questions",
          name: "ask_questions",
          arguments: {
            questions: [{ id: "name", header: "Name", question: "What is the name?" }],
          },
        },
        {
          type: "toolCall" as const,
          id: "after",
          name: "bash",
          arguments: { command: "touch /workspace/should-not-exist" },
        },
      ];

      const message = { ...assistant, stopReason: "toolUse" as const, content: calls };
      manager.appendMessage(message);
      const results = [];

      for (const call of calls) {
        const selected = options.customTools?.find((candidate) => candidate.name === call.name);

        if (!selected) throw new Error("Missing registered tool");

        const result = await selected.execute(
          call.id,
          call.arguments,
          new AbortController().signal,
          undefined,
          emptyExtensionContext,
        );

        const stored = {
          ...result,
          details: result.details === undefined ? undefined : jsonValueSchema.parse(result.details),
          role: "toolResult" as const,
          toolCallId: call.id,
          toolName: call.name,
          isError: false,
          timestamp: 1,
        };

        manager.appendMessage(stored);
        results.push(stored);
      }

      emit({ type: "turn_end", message, toolResults: results });
      expect(
        await agent.finishTurn?.(
          {
            message,
            toolResults: results,
            context: { messages: [message, ...results], tools: [] },
            newMessages: [message, ...results],
          },
          new AbortController().signal,
        ),
      ).toEqual({ action: "end" });
    },
  });

  const output = await harness.run();
  expect(output.questionRequest).toEqual(questions.pending());
  expect(saved[0]).toBeUndefined();
  expect(saved.filter(Boolean)).toHaveLength(2);
  expect(commands).toBe(0);
  expect(JSON.stringify(harness.checkpoints.at(-1))).toContain(
    "Not executed: waiting for the pending answers.",
  );
});

test("cancellation drains queued events and checkpoints while the store is healthy", async () => {
  const controller = new AbortController();
  const producing = Promise.withResolvers<void>();
  const promptStopped = Promise.withResolvers<void>();
  const writesUnblocked = Promise.withResolvers<void>();
  const cancellation = new Error("cancelled with queued writes");

  const harness = fixture({
    prompt: async (manager, emit) => {
      manager.appendMessage(assistant);
      emit({ type: "message_start", message: assistant });
      emit({ type: "message_start", message: assistant });
      emit({ type: "turn_end", message: assistant, toolResults: [] });
      producing.resolve();
      await promptStopped.promise;
    },
    emit: async () => {
      await writesUnblocked.promise;
    },
    abort: async () => promptStopped.resolve(),
  });

  const outcome = harness.run(controller.signal).then(
    () => "succeeded",
    (error: Error) => error,
  );

  await producing.promise;
  controller.abort(cancellation);
  await Promise.resolve();
  writesUnblocked.resolve();

  expect(await outcome).toBe(cancellation);
  expect(harness.calls.filter((call) => call === "event")).toHaveLength(2);
  expect(harness.checkpoints).toHaveLength(2);
  expect(harness.disposed()).toBe(1);
});

test("final checkpoint commits after unsubscribe and before disposal and return", async () => {
  const harness = fixture({
    prompt: async (manager) => {
      manager.appendMessage(assistant);
    },
    unsubscribe: (emit) => {
      queueMicrotask(() => emit({ type: "message_start", message: assistant }));
    },
  });

  const result = await harness.run();
  harness.calls.push("returned");
  expect(result.text).toBe("done");
  expect(harness.calls).toEqual([
    "checkpoint",
    "prompt-settled",
    "unsubscribe",
    "checkpoint",
    "dispose",
    "returned",
  ]);
  expect(harness.checkpoints.at(-1)?.entries.some((entry) => entry.type === "message")).toBe(true);
});

test("a queued turn checkpoint cannot change when the SDK later mutates its entries", async () => {
  const blocked = Promise.withResolvers<void>();
  const queued = Promise.withResolvers<void>();

  const harness = fixture({
    emit: async () => {
      await blocked.promise;
    },
    prompt: async (manager, emit) => {
      const message = {
        role: "user",
        content: "original",
        timestamp: 1,
      } satisfies Session["messages"][number];

      manager.appendMessage(message);
      emit({ type: "message_start", message });
      emit({ type: "turn_end", message, toolResults: [] });
      message.content = "mutated";
      queued.resolve();
      manager.appendMessage(assistant);
    },
  });

  const running = harness.run();
  await queued.promise;
  blocked.resolve();
  await running;
  const turn = harness.checkpoints[1];
  expect(JSON.stringify(turn)).toContain("original");
  expect(JSON.stringify(turn)).not.toContain("mutated");
});

test("subscription initialization failure disposes the already acquired session", async () => {
  const failure = new Error("subscription setup failed");
  const harness = fixture({ prompt: async () => {}, subscribeFailure: failure });
  await expect(harness.run()).rejects.toBe(failure);
  expect(harness.disposed()).toBe(1);
});

test("SDK tool and session failure details cannot reach emitted events or checkpoints", async () => {
  const secrets = [
    "PI_BEARER_SECRET",
    "PI_BASIC_SECRET",
    "PI_COOKIE_SECRET",
    "PI_SECOND_COOKIE",
    "PI_URL_SECRET",
  ];

  const credentials = `Authorization: Bearer ${secrets[0]}\nAuthorization: Basic ${secrets[1]}\nCookie: a="${secrets[2]}"; b=${secrets[3]}\nhttps://user:${secrets[4]}@example.test`;
  const emitted: PiEvent[] = [];

  const harness = fixture({
    emit: async (event) => {
      emitted.push(event);
    },
    prompt: async (manager, emit) => {
      manager.appendMessage({ ...assistant, stopReason: "error", errorMessage: credentials });
      emit({
        type: "tool_execution_end",
        toolCallId: "call",
        toolName: "bash",
        result: { content: [{ type: "text", text: credentials }], details: { cause: credentials } },
        isError: true,
      });
    },
  });

  await harness.run();

  for (const secret of secrets) {
    expect(JSON.stringify(emitted)).not.toContain(secret);
    expect(JSON.stringify(harness.checkpoints)).not.toContain(secret);
  }
});

for (const checkpointNumber of [1, 2]) {
  test(`cancellation during checkpoint ${checkpointNumber} drains its accepted write before disposal`, async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const committed = Promise.withResolvers<void>();
    const cancellation = new Error("cancelled during persistence");
    let writes = 0;
    let prompted = false;

    const harness = fixture({
      prompt: async (manager) => {
        prompted = true;
        manager.appendMessage(assistant);
      },
      checkpoint: async () => {
        if (++writes !== checkpointNumber) return;

        started.resolve();
        await committed.promise;
      },
    });

    const running = harness.run(controller.signal);

    // Attach rejection handling before delivering cancellation.
    const outcome = running.then(
      () => "succeeded",
      (error: Error) => error,
    );

    await started.promise;
    controller.abort(cancellation);
    await Promise.resolve();
    expect(harness.disposed()).toBe(0);
    committed.resolve();

    expect(await outcome).toBe(cancellation);
    expect(harness.disposed()).toBe(1);
    expect(writes).toBe(checkpointNumber);
    expect(prompted).toBe(checkpointNumber === 2);
  });
}

test("approval checkpoints stop Pi without requiring a final assistant response and preserve the tool boundary", async () => {
  const raw = {
    id: "10000000-0000-4000-8000-000000000001",
    toolCallId: "approval-call",
    repositoryUrl: "https://github.com/acme/private.git",
    repositoryId: 1,
    request: { kind: "pr_comment", number: 1, body: "Ready" },
    expectedHead: "a".repeat(40),
    base: "main",
    commit: null,
    bundleHash: null,
    preview: "Ready",
  } satisfies Omit<GitProposal, "digest">;

  const proposal = { ...raw, digest: proposalDigest(raw) };
  let pending: GitProposal | undefined;
  const saved: Array<{ toolResult: boolean; proposal?: GitProposal }> = [];

  const git: PiGitTools = {
    tools: [
      {
        name: "github_pr_comment",
        label: "Comment",
        description: "Propose a comment",
        parameters: Type.Object({}),
        executionMode: "sequential",
        execute: async () => ({ content: [], details: {} }),
      },
    ],
    pending: () => pending,
    refreshAccess: async () => {},
    receipt: async () => {
      throw new Error("No writes while waiting");
    },
  };

  const harness = fixture({
    git,
    prompt: async (manager, emit) => {
      const message = {
        ...assistant,
        stopReason: "toolUse" as const,
        content: [
          {
            type: "toolCall" as const,
            id: proposal.toolCallId,
            name: "github_pr_comment",
            arguments: { number: 1, body: "Ready" },
          },
        ],
      };

      manager.appendMessage(message);

      const result = {
        role: "toolResult" as const,
        toolCallId: proposal.toolCallId,
        toolName: "github_pr_comment",
        content: [{ type: "text" as const, text: "Waiting for approval" }],
        details: { approvalId: proposal.id },
        isError: false,
        timestamp: 1,
      };

      manager.appendMessage(result);
      pending = proposal;
      emit({ type: "turn_end", message, toolResults: [result] });
    },
    proposalCheckpoint: async (metadata, value) => {
      saved.push({
        proposal: value,
        toolResult: metadata.entries.some(
          (entry) => entry.type === "message" && entry.message.role === "toolResult",
        ),
      });
    },
  });

  const output = await harness.run();
  expect(output.approval).toEqual(proposal);
  expect(saved[0]?.proposal).toBeUndefined();
  expect(saved.filter((entry) => entry.proposal).every((entry) => entry.toolResult)).toBe(true);
  expect(harness.calls.indexOf("abort")).toBeGreaterThan(0);
  expect(harness.disposed()).toBe(1);
});

test("a mixed approval batch records skipped remote calls and uses the native turn stop hook", async () => {
  const raw = {
    id: "20000000-0000-4000-8000-000000000001",
    toolCallId: "approve",
    repositoryUrl: "https://github.com/acme/private.git",
    repositoryId: 1,
    request: { kind: "pr_comment", number: 1, body: "Ready" },
    expectedHead: "a".repeat(40),
    base: "main",
    commit: null,
    bundleHash: null,
    preview: "Ready",
  } satisfies Omit<GitProposal, "digest">;

  const proposal = { ...raw, digest: proposalDigest(raw) };
  let pending: GitProposal | undefined;
  let commands = 0;
  const agent: NonNullable<Session["agent"]> = {};

  const git: PiGitTools = {
    tools: [
      {
        name: "github_pr_comment",
        label: "Comment",
        description: "Propose",
        parameters: Type.Object({}),
        executionMode: "sequential",
        execute: async () => {
          pending = proposal;

          return {
            content: [{ type: "text", text: "Awaiting approval" }],
            details: { approvalId: proposal.id },
            terminate: true,
          };
        },
      },
    ],
    pending: () => pending,
    refreshAccess: async () => {},
    receipt: async () => {
      throw new Error("Unexpected dispatch");
    },
  };

  const harness = fixture({
    git,
    agent,
    onCommand: () => {
      commands++;
    },
    prompt: async (manager, emit, options) => {
      const calls: ToolCall[] = [
        { type: "toolCall" as const, id: "approve", name: "github_pr_comment", arguments: {} },
        {
          type: "toolCall" as const,
          id: "after",
          name: "bash",
          arguments: { command: "touch /workspace/should-not-exist" },
        },
      ];

      const message = { ...assistant, stopReason: "toolUse" as const, content: calls };
      manager.appendMessage(message);
      const results = [];

      for (const call of calls) {
        const tool = options.customTools?.find((tool) => tool.name === call.name);

        if (!tool) throw new Error("Missing registered tool");

        // SAFETY: Registered tools in this fixture never read the extension context.
        const result = await tool.execute(
          call.id,
          call.arguments,
          new AbortController().signal,
          undefined,
          {} as never,
        );

        const saved = {
          ...result,
          details: result.details === undefined ? undefined : jsonValueSchema.parse(result.details),
          role: "toolResult" as const,
          toolCallId: call.id,
          toolName: call.name,
          isError: false,
          timestamp: 1,
        };

        manager.appendMessage(saved);
        results.push(saved);
      }

      emit({ type: "turn_end", message, toolResults: results });
      expect(
        await agent.finishTurn?.(
          {
            message,
            toolResults: results,
            context: { messages: [message, ...results], tools: [] },
            newMessages: [message, ...results],
          },
          new AbortController().signal,
        ),
      ).toEqual({ action: "end" });
    },
  });

  expect((await harness.run()).approval?.id).toBe(proposal.id);
  expect(commands).toBe(0);
  expect(JSON.stringify(harness.checkpoints.at(-1))).toContain(
    "Not executed: waiting for the pending Git approval.",
  );
});

for (const path of ["refresh", "push"]) {
  for (const ambiguous of [false, true]) {
    test(`Git ${path} ${ambiguous ? "preserves unresolved command failures" : "keeps ordinary failures as tool results"}`, async () => {
      const failure = ambiguous
        ? new UnresolvedCommandError({ workspaceId: "workspace", generation: 1, commandId: "git" })
        : new Error("Git preparation rejected");

      let commands = 0;

      const git = createPiGitTools({
        client: {
          call: async (endpoint) => {
            if (endpoint === "access")
              return {
                repositoryUrl: "https://github.com/acme/private.git",
                url: "https://broker.example/git/read",
                token: "read-capability",
                expires: Date.now() + 900_000,
              };

            if (endpoint === "upload")
              return {
                id: "30000000-0000-4000-8000-000000000001",
                url: "https://broker.example/git/upload",
                token: "upload-capability",
              };
            throw new Error("Unexpected broker call");
          },
        },
        exec: async () => {
          commands++;

          if (commands === (path === "push" ? 2 : 1)) throw failure;

          return processResult("", "", 0);
        },
        maxBytes: 1024,
        minFreeBytes: 0,
      });

      const harness = fixture({
        git,
        prompt: async (manager, emit, options) => {
          const name = path === "push" ? "git_push" : "read";
          const tool = options.customTools?.find((candidate) => candidate.name === name);

          if (!tool) throw new Error("Missing registered tool");
          // The SDK catches tool exceptions and can still produce a final assistant response.
          // SAFETY: Both selected tools ignore the extension context.
          await expect(
            tool.execute(
              "git-call",
              path === "push" ? { source: "HEAD", branch: "main" } : { path: "README.md" },
              new AbortController().signal,
              undefined,
              {} as never,
            ),
          ).rejects.toBe(failure);
          manager.appendMessage(assistant);
          emit({ type: "turn_end", message: assistant, toolResults: [] });
        },
      });

      if (ambiguous) {
        await expect(harness.run()).rejects.toBe(failure);
        expect(harness.calls).toContain("abort");
      } else await expect(harness.run()).resolves.toMatchObject({ text: "done" });
      expect(harness.disposed()).toBe(1);
    });
  }
}

test("commentary, tool calls and the final message keep distinct per-message identities", async () => {
  const events: PiEvent[] = [];

  const commentary = {
    ...assistant,
    content: [{ type: "text" as const, text: "thinking out loud" }],
  };

  const final = { ...assistant, content: [{ type: "text" as const, text: "done" }] };

  const harness = fixture({
    emit: async (event) => {
      events.push(event);
    },
    prompt: async (manager, emit) => {
      emit({ type: "agent_start" });
      emit({ type: "message_start", message: commentary });
      emit({
        type: "message_update",
        message: commentary,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "thinking ",
          partial: commentary,
        },
      });
      emit({ type: "message_end", message: commentary });
      emit({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "read",
        args: { path: "a.txt" },
      });
      emit({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "read",
        result: { content: [{ type: "text", text: "file" }], details: { kind: "read" } },
        isError: false,
      });
      emit({ type: "message_start", message: final });
      emit({
        type: "message_update",
        message: final,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "done",
          partial: final,
        },
      });
      emit({ type: "message_end", message: final });
      manager.appendMessage(final);
      emit({ type: "turn_end", message: final, toolResults: [] });
    },
  });

  await harness.run();

  const assistantEvents = events.flatMap((event) =>
    event.type.startsWith("assistant.")
      ? [
          {
            type: event.type,
            assistantAttempt: event.payload.assistantAttempt,
            messageIndex: event.payload.messageIndex,
            content: event.payload.content,
          },
        ]
      : [],
  );

  // One turn attempt, two assistant messages: the second message opens a new
  // boundary instead of superseding the first, and the tool call stays between.
  expect(assistantEvents).toEqual([
    { type: "assistant.started", assistantAttempt: 1, messageIndex: 1, content: undefined },
    { type: "assistant.delta", assistantAttempt: 1, messageIndex: 1, content: "thinking " },
    {
      type: "assistant.message",
      assistantAttempt: 1,
      messageIndex: 1,
      content: "thinking out loud",
    },
    { type: "assistant.started", assistantAttempt: 1, messageIndex: 2, content: undefined },
    { type: "assistant.delta", assistantAttempt: 1, messageIndex: 2, content: "done" },
    { type: "assistant.message", assistantAttempt: 1, messageIndex: 2, content: "done" },
  ]);

  const order = events.map((event) => event.type);
  expect(order.indexOf("assistant.message")).toBeLessThan(order.indexOf("tool.started"));
  expect(order.lastIndexOf("assistant.started")).toBeGreaterThan(order.indexOf("tool.completed"));

  // Every identity is unique, so a projection can never merge the two messages.
  const keys = new Set(events.map((event) => event.dedupeKey));
  expect(keys.size).toBe(events.length);
});

test("reasoning streams as its own delta kind and the final message carries it without the signature", async () => {
  const events: PiEvent[] = [];

  const message = {
    ...assistant,
    content: [
      { type: "thinking" as const, thinking: "**Plan**\n\nRead a", thinkingSignature: "secret" },
      { type: "thinking" as const, thinking: "**Check**", thinkingSignature: "secret" },
      { type: "text" as const, text: "done" },
    ],
  };

  const thinking = (contentIndex: number, delta: string) => ({
    type: "message_update" as const,
    message,
    assistantMessageEvent: {
      type: "thinking_delta" as const,
      contentIndex,
      delta,
      partial: message,
    },
  });

  const harness = fixture({
    emit: async (event) => {
      events.push(event);
    },
    prompt: async (manager, emit) => {
      emit({ type: "agent_start" });
      emit({ type: "message_start", message });
      emit(thinking(0, "**Plan**\n\nRead a"));
      emit(thinking(1, "**Check**"));
      emit({ type: "message_end", message });
      manager.appendMessage(message);
      emit({ type: "turn_end", message, toolResults: [] });
    },
  });

  await harness.run();

  const deltas = events.filter((event) => event.type === "assistant.reasoning.delta");

  // Both thinking blocks arrive within one flush window, separated as in the final message.
  expect(deltas.map((event) => event.payload.delta)).toEqual(["**Plan**\n\nRead a\n\n**Check**"]);
  expect(events.filter((event) => event.type === "assistant.delta")).toEqual([]);

  const final = events.find((event) => event.type === "assistant.message");

  expect(final?.payload).toMatchObject({
    content: "done",
    reasoning: "**Plan**\n\nRead a\n\n**Check**",
    reasoningTruncated: false,
  });
  expect(JSON.stringify(events)).not.toContain("secret");
  expect(new Set(events.map((event) => event.dedupeKey)).size).toBe(events.length);
});

function streamedMessage(reasoning: string, text: string) {
  const message = {
    ...assistant,
    content: [
      { type: "thinking" as const, thinking: reasoning },
      { type: "text" as const, text },
    ],
  };

  const update = (type: "thinking_delta" | "text_delta", delta: string) => ({
    type: "message_update" as const,
    message,
    assistantMessageEvent: {
      type,
      contentIndex: type === "thinking_delta" ? 0 : 1,
      delta,
      partial: message,
    },
  });

  return { message, update };
}

/** Concatenated delta text per message and kind, which is all a reader projects. */
function streamedText(events: PiEvent[]) {
  const text = new Map<string, string>();

  for (const event of events) {
    if (event.type !== "assistant.delta" && event.type !== "assistant.reasoning.delta") continue;
    const key = `${String(event.payload.messageIndex)}:${event.type}`;
    text.set(key, (text.get(key) ?? "") + String(event.payload.delta));
  }

  return Object.fromEntries(text);
}

test("coalesced deltas project the same text in order with far fewer events", async () => {
  const events: PiEvent[] = [];
  const reasoning = "Inspecting the sidebar and its thread query before changing it.";
  const answer = "Grouped the sidebar by repository.";
  const first = streamedMessage(reasoning, "Checking files.");
  const second = streamedMessage(reasoning, answer);
  const pieces = (text: string) => text.match(/.{1,5}/gsu) ?? [];

  const harness = fixture({
    emit: async (event) => {
      events.push(event);
    },
    prompt: async (manager, emit) => {
      emit({ type: "agent_start" });

      for (const [{ message, update }, text] of [
        [first, "Checking files."],
        [second, answer],
      ] as const) {
        emit({ type: "message_start", message });

        for (const piece of pieces(reasoning)) emit(update("thinking_delta", piece));

        for (const piece of pieces(text)) emit(update("text_delta", piece));

        emit({ type: "message_end", message });
        manager.appendMessage(message);
      }

      emit({ type: "turn_end", message: second.message, toolResults: [] });
    },
  });

  await harness.run();

  expect(streamedText(events)).toEqual({
    "1:assistant.reasoning.delta": reasoning,
    "1:assistant.delta": "Checking files.",
    "2:assistant.reasoning.delta": reasoning,
    "2:assistant.delta": answer,
  });
  // One event per kind per message instead of one per five-character piece.
  expect(events.filter((event) => event.type.endsWith(".delta"))).toHaveLength(4);
  expect(events.map((event) => event.type)).toEqual([
    "assistant.started",
    "assistant.reasoning.delta",
    "assistant.delta",
    "assistant.message",
    "assistant.started",
    "assistant.reasoning.delta",
    "assistant.delta",
    "assistant.message",
  ]);
  expect(
    events.flatMap((event) => (event.type.endsWith(".delta") ? [event.payload.deltaIndex] : [])),
  ).toEqual([0, 1, 2, 3]);
  expect(new Set(events.map((event) => event.dedupeKey)).size).toBe(events.length);
});

test("buffered deltas stream within the flush window and before the size limit", async () => {
  const events: PiEvent[] = [];
  const { message, update } = streamedMessage("", "x".repeat(5000));

  const harness = fixture({
    emit: async (event) => {
      events.push(event);
    },
    prompt: async (manager, emit) => {
      emit({ type: "agent_start" });
      emit({ type: "message_start", message });
      emit(update("text_delta", "early"));
      await new Promise((resolve) => setTimeout(resolve, 250));
      // The timer wrote the first piece while the message was still streaming.
      expect(streamedText(events)).toEqual({ "1:assistant.delta": "early" });
      emit(update("text_delta", "x".repeat(5000)));
      // Persistence is asynchronous; the size limit wrote without waiting for the timer.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(events.filter((event) => event.type === "assistant.delta")).toHaveLength(2);
      emit({ type: "message_end", message });
      manager.appendMessage(message);
      emit({ type: "turn_end", message, toolResults: [] });
    },
  });

  await harness.run();
});

test("text buffered when a run is aborted mid-message is still persisted", async () => {
  const events: PiEvent[] = [];
  const controller = new AbortController();
  const { message, update } = streamedMessage("thinking", "partial answer");

  const harness = fixture({
    emit: async (event) => {
      events.push(event);
    },
    prompt: async (_manager, emit) => {
      emit({ type: "agent_start" });
      emit({ type: "message_start", message });
      emit(update("thinking_delta", "thinking"));
      emit(update("text_delta", "partial "));
      emit(update("text_delta", "answer"));
      controller.abort();
    },
  });

  await expect(harness.run(controller.signal)).rejects.toThrow();
  expect(streamedText(events)).toEqual({
    "1:assistant.reasoning.delta": "thinking",
    "1:assistant.delta": "partial answer",
  });
});

test("a continued turn after a question uses a new attempt identity, not a replacement", async () => {
  const events: PiEvent[] = [];

  const harness = fixture({
    emit: async (event) => {
      events.push(event);
    },
    prompt: async (manager, emit) => {
      emit({ type: "agent_start" });
      emit({ type: "message_start", message: assistant });
      emit({ type: "message_end", message: assistant });
      manager.appendMessage(assistant);
      emit({ type: "turn_end", message: assistant, toolResults: [] });
    },
  });

  await harness.run();

  // The attempt id is part of every identity. A resumed attempt emits the same
  // turn and message indexes under a new attempt id, so a projection appends a
  // continuation instead of replacing the earlier failed attempt's content.
  for (const event of events) expect(event.dedupeKey).toContain(":attempt:attempt:");

  const resumed = events.find((event) => event.type === "assistant.started");

  expect(resumed?.dedupeKey).toBe(assistantStartedDedupeKey("run", "attempt", 1, 1));
  expect(resumed?.dedupeKey).not.toBe(assistantStartedDedupeKey("run", "attempt-2", 1, 1));
  expect(events.some((event) => event.type === "assistant.message")).toBe(true);
});

test("structured write and edit results reach tool.completed through tool details", async () => {
  const events: PiEvent[] = [];

  const writeResult = {
    kind: "write",
    path: "/workspace/new.ts",
    change: "created",
    bytes: 7,
    preview: "content",
    previewBytes: 7,
    previewTruncated: false,
  };

  const editResult = {
    kind: "edit",
    version: 1,
    path: "/workspace/new.ts",
    replacementCount: 1,
    unifiedDiff: "--- a\n+++ b\n",
    additions: 1,
    deletions: 1,
    beforeHash: "a".repeat(64),
    afterHash: "b".repeat(64),
    diffTruncated: false,
  };

  const harness = fixture({
    emit: async (event) => {
      events.push(event);
    },
    onCommand: () => undefined,
    sandboxExec: (request) =>
      request.stdin === "content"
        ? processResult(JSON.stringify(writeResult), "", 0)
        : processResult(JSON.stringify(editResult), "", 0),
    prompt: async (manager, emit, options) => {
      const calls: ToolCall[] = [
        {
          type: "toolCall" as const,
          id: "write-1",
          name: "write",
          arguments: { path: "new.ts", content: "content" },
        },
        {
          type: "toolCall" as const,
          id: "edit-1",
          name: "edit",
          arguments: { path: "new.ts", edits: [{ oldText: "content", newText: "changed" }] },
        },
      ];

      const message = { ...assistant, stopReason: "toolUse" as const, content: calls };
      manager.appendMessage(message);
      const results = [];

      for (const call of calls) {
        const tool = options.customTools?.find((candidate) => candidate.name === call.name);

        if (!tool) throw new Error("Missing registered tool");

        emit({
          type: "tool_execution_start",
          toolCallId: call.id,
          toolName: call.name,
          args: call.arguments,
        });

        // SAFETY: Registered tools in this fixture never read the extension context.
        const result = await tool.execute(
          call.id,
          call.arguments,
          new AbortController().signal,
          undefined,
          {} as never,
        );

        const saved = {
          ...result,
          details: result.details === undefined ? undefined : jsonValueSchema.parse(result.details),
          role: "toolResult" as const,
          toolCallId: call.id,
          toolName: call.name,
          isError: false,
          timestamp: 1,
        };

        manager.appendMessage(saved);
        results.push(saved);
        emit({
          type: "tool_execution_end",
          toolCallId: call.id,
          toolName: call.name,
          result,
          isError: false,
        });
      }

      emit({ type: "turn_end", message, toolResults: results });
    },
  });

  await harness.run();

  const completed = events.flatMap((event) =>
    event.type === "tool.completed" ? [event.payload] : [],
  );

  expect(completed).toHaveLength(2);
  expect(completed[0]?.result).toMatchObject({ kind: "write", change: "created", bytes: 7 });
  expect(completed[1]?.result).toMatchObject({ kind: "edit", replacementCount: 1 });

  // Write arguments are previewed in the durable event; the full content stays
  // in the Pi checkpoint.
  const started = events.find((event) => event.type === "tool.started");

  const args = z
    .object({ contentPreview: z.string().optional(), contentBytes: z.number().optional() })
    .safeParse(started?.payload.args).data;

  expect(args?.contentPreview).toBe("content");
  expect(args?.contentBytes).toBe(7);
  expect(JSON.stringify(started?.payload)).not.toContain('"content":"content"');
});

test("bash commands default to two minutes and accept a timeout up to ten minutes", async () => {
  const timeouts: (number | undefined)[] = [];

  const harness = fixture({
    sandboxExec: (request) => {
      timeouts.push(request.timeoutMs);

      return processResult("", "", 0);
    },
    prompt: async (_manager, _emit, options) => {
      const tool = options.customTools?.find((candidate) => candidate.name === "bash");

      if (!tool) throw new Error("Missing registered tool");

      for (const args of [{ command: "true" }, { command: "true", timeout: 300 }])
        // SAFETY: bash never reads the extension context.
        await tool.execute("call", args, new AbortController().signal, undefined, {} as never);
    },
  });

  await harness.run();

  expect(timeouts).toEqual([120_000, 300_000]);
});

test("bash passes the guest environment as process env, never in the command", async () => {
  const requests: Array<{ command: string; env?: Record<string, string> }> = [];

  const harness = fixture({
    guestEnvironment: { PREVIEW_URL_TEMPLATE: "https://{port}-abc.p.example.com", SECRET: "it's" },
    sandboxExec: (request) => {
      requests.push(request);

      return processResult("", "", 0);
    },
    prompt: async (_manager, _emit, options) => {
      const tool = options.customTools?.find((candidate) => candidate.name === "bash");

      if (!tool) throw new Error("Missing registered tool");
      // SAFETY: bash never reads the extension context.
      await tool.execute(
        "call",
        { command: "env" },
        new AbortController().signal,
        undefined,
        {} as never,
      );
    },
  });

  await harness.run();

  const request = requests.find((candidate) => candidate.command.endsWith("env"));
  expect(request?.env).toEqual({
    PREVIEW_URL_TEMPLATE: "https://{port}-abc.p.example.com",
    SECRET: "it's",
  });
  expect(request?.command).not.toContain("it's");
  expect(request?.command).not.toContain("export");
});
