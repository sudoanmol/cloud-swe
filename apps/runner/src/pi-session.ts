import type { CredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { Logger } from "pino";
import { modelProviders } from "@cloud-swe/db/model-selection";
import { piOperation, PI_WRITER_DEFAULT_CLEANUP_TIMEOUT_MS } from "./pi-persistence.js";
import type { RemoteResources } from "./remote-resources.js";

type PiAgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

export type PiSessionLike = Pick<
  PiAgentSession,
  "sessionId" | "messages" | "subscribe" | "prompt" | "abort" | "dispose"
> & { agent?: Pick<PiAgentSession["agent"], "finishTurn"> };

export type CreateAgentSessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;

export type PiSessionFactory = (
  options: CreateAgentSessionOptions,
) => Promise<{ session: PiSessionLike }>;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SDK creation rejects with arbitrary provider values at this cancellation boundary.
export async function createPiSession(
  factory: PiSessionFactory,
  options: CreateAgentSessionOptions,
  signal: AbortSignal,
): Promise<{ session: PiSessionLike }> {
  signal.throwIfAborted();
  const pending = factory(options);

  return new Promise<{ session: PiSessionLike }>((resolve, reject) => {
    let settled = false;

    const onAbort = () => {
      settled = true;
      reject(signal.reason ?? new Error("Pi session creation cancelled"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    void pending.then(
      (created) => {
        signal.removeEventListener("abort", onAbort);

        if (settled || signal.aborted) {
          void Promise.resolve()
            .then(() => created.session.dispose())
            .catch(() => undefined);

          return;
        }

        settled = true;
        resolve(created);
      },
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the SDK rejection for the caller.
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);

        if (!settled) {
          settled = true;
          reject(error);
        }
      },
    );
  });
}

export async function disposePiSession(
  session: PiSessionLike,
  logger: Pick<Logger, "warn"> | undefined,
): Promise<void> {
  try {
    await Effect.runPromise(
      piOperation(() => Promise.resolve(session.dispose()), {
        timeoutMs: PI_WRITER_DEFAULT_CLEANUP_TIMEOUT_MS,
      }),
    );
  } catch {
    logger?.warn({ resource: "pi-session" }, "Pi session cleanup failed");
  }
}

export function textFromMessages(session: Pick<PiAgentSession, "messages">): string {
  let text = "";

  for (const message of session.messages) {
    if (message.role !== "assistant") continue;
    text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  }

  return text;
}

/** Keep the SDK's request-time auth resolution, with no ambient worker keys. */
export async function createPiModelRuntime(credentials: CredentialStore, providerId: string) {
  const provider = modelProviders.find((candidate) => candidate.id === providerId);

  if (!provider) throw new Error("Unsupported model provider");

  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  });

  runtime.registerNativeProvider({
    ...provider,
    auth:
      providerId === "openai-codex"
        ? provider.auth
        : {
            apiKey: {
              name: provider.name,
              resolve: async ({ credential }) =>
                credential?.key ? { auth: { apiKey: credential.key } } : undefined,
            },
          },
  });

  return runtime;
}

/**
 * Synchronous getters use only a captured remote snapshot. Worker-global
 * resources, native skill expansion and JavaScript extensions stay disabled.
 */
export function createPiResourceLoader(
  resources?: RemoteResources,
  systemAppend?: string,
): ResourceLoader {
  const extensionRuntime = createExtensionRuntime();

  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: extensionRuntime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: resources?.instructions ?? [] }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [
      "User mentions @path/to/file refer to workspace files; $skill-name asks you to read and follow that skill from the catalog.",
      ...(resources?.catalog ? [resources.catalog] : []),
      ...(systemAppend ? [systemAppend] : []),
    ],
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: async () => undefined,
  };
}

type PiModelSelection = { piProvider?: string; piModel?: string; credentials?: CredentialStore };

/**
 * Tests that inject a session factory skip model resolution and carry the
 * persisted identity, or a placeholder. This stays synchronous so the factory
 * is called without yielding first.
 */
export function injectedPiModel(selection: PiModelSelection) {
  return {
    runtime: undefined,
    model: undefined,
    modelProvider: selection.piProvider?.trim() ?? "injected",
    modelIdentifier: selection.piModel?.trim() ?? "injected",
  };
}

/** Resolve the persisted provider/model to a runtime and SDK model. */
export async function resolvePiModel(selection: PiModelSelection) {
  const provider = selection.piProvider?.trim();
  const modelId = selection.piModel?.trim();

  if (!provider) throw new Error("Pi provider is required");

  if (!modelId) throw new Error("Pi model is required");

  if (!selection.credentials) throw new Error("Model credentials are required");

  const runtime = await createPiModelRuntime(selection.credentials, provider);
  const model = runtime.getModel(provider, modelId);

  if (!model) throw new Error(`Unknown Pi model: ${provider}/${modelId}`);

  return { runtime, model, modelProvider: model.provider, modelIdentifier: model.id };
}
