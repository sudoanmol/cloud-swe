import { expect, test } from "bun:test";
import {
  createPiExecutor,
  type PiExecutorDependencies,
  type PiPersistedSessionMetadata,
  type PiEvent,
} from "../src/pi.js";
import { processResult } from "../src/sandbox.js";
import { Type } from "typebox";
import { createPiGitTools, type PiGitTools } from "../src/git-tools.js";
import { UnresolvedCommandError } from "../src/execution-coordinator.js";
import { proposalDigest, type GitProposal } from "@cloud-swe/db/git-contracts";
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
  emit?: (event: PiEvent) => Promise<void>;
  checkpoint?: (metadata: PiPersistedSessionMetadata) => Promise<void>;
  unsubscribe?: (emit: Subscriber) => void;
  subscribeFailure?: Error;
  abort?: () => Promise<void>;
  git?: PiGitTools;
  questions?: PiQuestionTools;
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
      workspace: {
        id: "workspace",
        threadId: "thread",
        name: "test",
        provider: "docker",
        providerId: null,
        generation: 1,
      },
      sandbox: {
        exec: async () => {
          hooks.onCommand?.();

          return processResult("", "", 0);
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
      const calls = [
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
          name: "remote_exec",
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
        await agent.shouldStopAfterTurn?.(emptyExtensionContext, new AbortController().signal),
      ).toBe(true);
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
      emit({ type: "agent_start" });
      emit({ type: "agent_start" });
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
      queueMicrotask(() => emit({ type: "agent_start" }));
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
      emit({ type: "agent_start" });
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
        toolName: "remote_exec",
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
      const calls = [
        { type: "toolCall" as const, id: "approve", name: "github_pr_comment", arguments: {} },
        {
          type: "toolCall" as const,
          id: "after",
          name: "remote_exec",
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
        await agent.shouldStopAfterTurn?.(
          {
            message,
            toolResults: results,
            context: { systemPrompt: "", messages: [message, ...results], tools: [] },
            newMessages: [message, ...results],
          },
          new AbortController().signal,
        ),
      ).toBe(true);
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
          const name = path === "push" ? "git_push" : "remote_read";
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
