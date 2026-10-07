import { Match } from "effect";
import { boundedUtf8 } from "./text.js";
import {
  AlreadyExistsError,
  ModalClient,
  NotFoundError,
  Probe,
  SnapshotCreationError,
  type App,
  type Image,
  type Sandbox,
} from "modal";
import { ThreadStoreError } from "@cloud-swe/db/thread-contracts";
import { z } from "zod";
import type { Logger } from "pino";
import type { RunnerConfig } from "./config.js";
import {
  assertWorkspaceProvider,
  boundedProviderCall,
  processResult,
  publicErrorFields,
  providerOutputMaxBytes,
  providerTimeoutMs,
  SandboxProviderError,
  transportResult,
  withProviderBudget,
  type CommandRequest,
  type CommandResult,
  type EnsureResult,
  type LifecycleResult,
  type SandboxProvider,
  type WorkspaceRef,
  type WorkspaceResolution,
} from "./sandbox.js";

const commandGraceMs = 5_000;

const managedTag = "cloud-swe.managed";

const workspaceIdTag = "cloud-swe.workspace-id";

const threadIdTag = "cloud-swe.thread-id";

/** The sandbox whose exit snapshot this sandbox was created from, or `base`. */
const restoredFromTag = "cloud-swe.restored-from";

/** Epoch milliseconds when Modal terminates the sandbox at its hard timeout. */
const expiresAtTag = "cloud-swe.expires-at";

/** supervisord owns Docker. The sandbox ends when it exits. */
const entrypoint = ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"];

const exitSnapshotTimeoutMs = 60_000;

/** Docker starts last among the entrypoint's services a guest command may need. */
const readinessProbe = Probe.withExec(["docker", "info"], { intervalMs: 500 });

const readinessTimeoutMs = 60_000;

/** gRPC NOT_FOUND. A deleted snapshot still resolves to an Image reference. */
const missingImageSchema = z.object({ code: z.literal(5) });

type Located = { sandbox: Sandbox; running: boolean; tags: Record<string, string> };

type Resolution = WorkspaceResolution & { located: Located | null };

function safeSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return (slug || "cloud-swe-workspace").slice(0, 63).replace(/-$/, "") || "cloud-swe-workspace";
}

function validateManaged(tags: Record<string, string>, workspace: WorkspaceRef): void {
  if (tags[managedTag] !== "true")
    throw new Error("Refusing to operate an unmanaged Modal sandbox");

  if (tags[workspaceIdTag] !== workspace.id)
    throw new Error("Refusing to operate a Modal sandbox for another workspace");

  if (tags[threadIdTag] !== workspace.threadId)
    throw new Error("Refusing to operate a Modal sandbox for another thread");
}

function publicError(operation: string, cause: unknown): Error {
  if (cause instanceof ThreadStoreError || cause instanceof SandboxProviderError) return cause;

  return new Error(`Modal ${operation} failed`, { cause });
}

function lifecycleUnknown(action: "pause" | "delete", workspace: WorkspaceRef): LifecycleResult {
  return { action, outcome: "unknown", providerId: workspace.providerId, recovered: false };
}

export function createModalProvider(
  config: RunnerConfig,
  logger: Logger,
  dependencies: { client?: ModalClient } = {},
): SandboxProvider {
  if (!config.modal) throw new Error("MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are required");
  const modal = config.modal;

  const client =
    dependencies.client ??
    new ModalClient({
      tokenId: modal.tokenId,
      tokenSecret: modal.tokenSecret,
      environment: modal.environment,
    });

  const timeoutMs = providerTimeoutMs(config);
  const outputLimit = providerOutputMaxBytes(config);
  let appPromise: Promise<App> | undefined;

  function call<T>(
    operation: string,
    signal: AbortSignal,
    run: () => Promise<T>,
    budget = timeoutMs,
  ) {
    return boundedProviderCall({ operation, signal, timeoutMs: budget, call: run });
  }

  async function app(signal: AbortSignal): Promise<App> {
    const pending = (appPromise ??= client.apps.fromName(modal.appName, { createIfMissing: true }));

    try {
      return await call("app lookup", signal, () => pending);
    } catch (error) {
      appPromise = undefined;
      throw error;
    }
  }

  /** The lifetime one run needs: preparation, execution, and idle grace. */
  const requiredLifetimeMs =
    config.workspacePreparationTimeoutMs + config.maxRunMs + 60_000 + config.idlePauseMs;

  async function locate(sandbox: Sandbox, workspace: WorkspaceRef, signal: AbortSignal) {
    const exitCode = await call("sandbox poll", signal, () => sandbox.poll());
    const tags = await call("sandbox tags", signal, () => sandbox.getTags());
    validateManaged(tags, workspace);

    return { sandbox, running: exitCode === null, tags };
  }

  async function byName(workspace: WorkspaceRef, signal: AbortSignal): Promise<Located | null> {
    try {
      const sandbox = await call("sandbox name lookup", signal, () =>
        client.sandboxes.fromName(modal.appName, safeSlug(workspace.name)),
      );

      return await locate(sandbox, workspace, signal);
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  async function byId(id: string, workspace: WorkspaceRef, signal: AbortSignal) {
    try {
      return await locate(await client.sandboxes.fromId(id), workspace, signal);
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  /**
   * A running sandbox under the workspace name is authoritative. It continues
   * the stored filesystem when it is the stored sandbox or was restored from
   * it; otherwise the stored filesystem was replaced. A finished stored sandbox
   * is still present because its exit snapshot holds the filesystem.
   */
  async function resolveInternal(
    workspace: WorkspaceRef,
    signal: AbortSignal,
  ): Promise<Resolution> {
    assertWorkspaceProvider(workspace, "modal");
    const stored = workspace.providerId;
    const named = await byName(workspace, signal);

    if (named) {
      const id = named.sandbox.sandboxId;
      const continues = !stored || id === stored || named.tags[restoredFromTag] === stored;

      return {
        workspace: { ...workspace, providerId: id },
        disposition: continues ? "present" : "replaced",
        recovered: id !== stored,
        previousProviderId: continues ? undefined : (stored ?? undefined),
        expiresAt: expiresAt(named),
        located: named,
      };
    }

    const located = stored ? await byId(stored, workspace, signal) : null;

    if (!located)
      return {
        workspace: { ...workspace, providerId: null },
        disposition: "missing",
        recovered: false,
        located: null,
      };

    return {
      workspace,
      disposition: "present",
      recovered: false,
      expiresAt: expiresAt(located),
      located,
    };
  }

  function expiresAt(located: Located) {
    const deadline = Number(located.tags[expiresAtTag]);

    return located.running && Number.isFinite(deadline) ? deadline : undefined;
  }

  async function capacity(signal: AbortSignal): Promise<void> {
    const { appId } = await app(signal);

    const running = await call("sandbox inventory", signal, async () => {
      let count = 0;

      for await (const _ of client.sandboxes.list({ appId, tags: { [managedTag]: "true" } }))
        count++;

      return count;
    });

    if (running >= modal.sandboxLimit)
      throw new ThreadStoreError("PROVIDER_CAPACITY", "Provider capacity is full", 503);
  }

  async function create(
    workspace: WorkspaceRef,
    image: Image,
    restoredFrom: string,
    signal: AbortSignal,
  ): Promise<Sandbox> {
    await capacity(signal);
    const target = await app(signal);

    const tags = {
      [managedTag]: "true",
      [workspaceIdTag]: workspace.id,
      [threadIdTag]: workspace.threadId,
      [restoredFromTag]: restoredFrom,
      [expiresAtTag]: String(Date.now() + modal.maxRunSeconds * 1000),
    };

    try {
      const sandbox = await call("sandbox create", signal, () =>
        client.sandboxes.create(target, image, {
          name: safeSlug(workspace.name),
          tags,
          command: entrypoint,
          workdir: "/workspace",
          cpu: 2,
          memoryMiB: 4096,
          timeoutMs: modal.maxRunSeconds * 1000,
          readinessProbe,
          experimentalOptions: { vm_runtime: true, enable_exit_snapshot: true },
        }),
      );

      return sandbox;
    } catch (error) {
      // A lost response may still have created the sandbox. The name is unique
      // among running sandboxes, so adopt the one this create produced.
      if (signal.aborted && !(error instanceof AlreadyExistsError)) throw error;
      const adopted = await byName(workspace, signal);

      if (adopted?.running && adopted.tags[restoredFromTag] === restoredFrom) {
        logger.warn(
          { workspaceId: workspace.id, providerId: adopted.sandbox.sandboxId },
          "Reconciled Modal sandbox create",
        );

        return adopted.sandbox;
      }

      throw error;
    }
  }

  /** A returned sandbox runs guest commands and Docker immediately. */
  async function ready(sandbox: Sandbox, signal: AbortSignal): Promise<string> {
    await call(
      "sandbox readiness",
      signal,
      () => sandbox.waitUntilReady(readinessTimeoutMs),
      readinessTimeoutMs + timeoutMs,
    );

    return sandbox.sandboxId;
  }

  async function terminate(sandbox: Sandbox, signal: AbortSignal): Promise<void> {
    await call("sandbox terminate", signal, () => sandbox.terminate({ wait: true }));
  }

  /** The finished sandbox's filesystem, or null when Modal no longer has it. */
  async function exitSnapshot(sandbox: Sandbox, signal: AbortSignal): Promise<Image | null> {
    try {
      return await call(
        "exit snapshot",
        signal,
        () => sandbox.experimentalGetExitSnapshot({ timeoutMs: exitSnapshotTimeoutMs }),
        exitSnapshotTimeoutMs + timeoutMs,
      );
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof SnapshotCreationError) return null;
      throw error;
    }
  }

  async function baseImage(signal: AbortSignal): Promise<Image> {
    return await call("image lookup", signal, () => client.images.fromName(modal.imageName));
  }

  /** Null when the exit snapshot was deleted after the sandbox finished. */
  async function restore(
    workspace: WorkspaceRef,
    image: Image,
    restoredFrom: string,
    signal: AbortSignal,
  ): Promise<Sandbox | null> {
    try {
      return await create(workspace, image, restoredFrom, signal);
    } catch (error) {
      if (missingImageSchema.safeParse(error).success) return null;
      throw error;
    }
  }

  async function ensure(workspace: WorkspaceRef, signal: AbortSignal): Promise<EnsureResult> {
    const resolution = await resolveInternal(workspace, signal);
    const located = resolution.located;
    const previousProviderId = resolution.previousProviderId ?? workspace.providerId ?? undefined;

    if (located?.running) {
      const remaining = Number(located.tags[expiresAtTag]) - Date.now();

      if (remaining >= requiredLifetimeMs)
        return {
          providerId: await ready(located.sandbox, signal),
          disposition: resolution.disposition === "replaced" ? "replaced" : "existing",
          previousProviderId: resolution.previousProviderId,
          recovered: resolution.recovered,
        };

      // Too little lifetime remains for a run. Start a new lifetime from the
      // current filesystem instead of letting the hard timeout interrupt it.
      await terminate(located.sandbox, signal);
    }

    if (located) {
      const image = await exitSnapshot(located.sandbox, signal);
      const id = located.sandbox.sandboxId;

      const restored = image ? await restore(workspace, image, id, signal) : null;

      if (restored) {
        const providerId = await ready(restored, signal);
        logger.info({ workspaceId: workspace.id, providerId }, "Modal sandbox restored");

        return {
          providerId,
          disposition: resolution.disposition === "replaced" ? "replaced" : "restored",
          previousProviderId,
          recovered: resolution.recovered,
        };
      }

      logger.warn({ workspaceId: workspace.id, providerId: id }, "Modal exit snapshot is gone");
    }

    const providerId = await ready(
      await create(workspace, await baseImage(signal), "base", signal),
      signal,
    );

    logger.info({ workspaceId: workspace.id, providerId }, "Modal sandbox created");

    return {
      providerId,
      disposition: workspace.providerId ? "replaced" : "created",
      previousProviderId: workspace.providerId ?? undefined,
      recovered: false,
    };
  }

  async function lifecycle(
    workspace: WorkspaceRef,
    action: "pause" | "delete",
    signal: AbortSignal,
  ): Promise<LifecycleResult> {
    try {
      const resolution = await resolveInternal(workspace, signal);
      const located = resolution.located;

      if (!located) return { action, outcome: "missing", providerId: null, recovered: false };

      if (located.running) await terminate(located.sandbox, signal);

      // Pause completes once the filesystem is captured. Delete also removes
      // that capture; older snapshots in the chain expire with their TTL.
      const image = await exitSnapshot(located.sandbox, signal);

      if (action === "delete" && image) {
        try {
          await call("image delete", signal, () => client.images.delete(image.imageId));
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
        }
      }

      logger.info(
        { workspaceId: workspace.id, providerId: located.sandbox.sandboxId, action },
        "Modal lifecycle completed",
      );

      return {
        action,
        outcome: "completed",
        providerId: located.sandbox.sandboxId,
        recovered: resolution.recovered,
      };
    } catch (error) {
      logger.warn(
        { workspaceId: workspace.id, action, ...publicErrorFields(error) },
        "Modal lifecycle outcome unknown",
      );

      return lifecycleUnknown(action, workspace);
    }
  }

  async function exec(
    workspace: WorkspaceRef,
    request: CommandRequest,
    signal: AbortSignal,
  ): Promise<CommandResult> {
    assertWorkspaceProvider(workspace, "modal");
    signal.throwIfAborted();
    const providerId = workspace.providerId;

    if (!providerId) throw new Error("Modal workspace has no provider id");
    const requestedTimeout = Math.max(1, request.timeoutMs ?? timeoutMs);

    try {
      // Modal's own exec timeout reports 137, indistinguishable from a guest
      // SIGKILL. The client deadline instead yields an ambiguous transport
      // result, and reconciliation reads the guest journal.
      const result = await call(
        "guest command",
        signal,
        async () => {
          const sandbox = await client.sandboxes.fromId(providerId);

          const child = await sandbox.exec(["/bin/bash", "-c", request.command], {
            env: request.env,
          });

          if (request.stdin !== undefined) await child.stdin.writeText(request.stdin);
          await child.stdin.close();

          const [stdout, stderr, statusCode] = await Promise.all([
            child.stdout.readText(),
            child.stderr.readText(),
            child.wait(),
          ]);

          return { stdout, stderr, statusCode };
        },
        Math.max(timeoutMs, requestedTimeout + commandGraceMs),
      );

      const stdout = boundedUtf8(result.stdout, outputLimit);
      const remaining = Math.max(0, outputLimit - Buffer.byteLength(stdout.text, "utf8"));
      const stderr = boundedUtf8(result.stderr, remaining);

      if (stdout.truncated || stderr.truncated)
        return transportResult(
          "output-limit",
          "Modal command output exceeded the configured limit",
          stdout.text,
          stderr.text,
          true,
        );

      return processResult(stdout.text, stderr.text, result.statusCode, false);
    } catch (error) {
      if (error instanceof SandboxProviderError)
        return Match.value(error.kind).pipe(
          Match.when("timeout", () =>
            transportResult("transport-timeout", "Modal guest command timed out"),
          ),
          Match.when("cancelled", () =>
            transportResult("cancelled", "Modal guest command cancelled"),
          ),
          Match.when("unknown", () =>
            transportResult("unknown", "Modal guest command transport failed"),
          ),
          Match.exhaustive,
        );
      // Do not expose SDK request details in run errors. Reconciliation gets
      // the chance to identify a guest result.
      logger.warn({ workspaceId: workspace.id }, "Modal guest command transport failed");

      return transportResult("unknown", "Modal guest command transport failed");
    }
  }

  async function guarded<T>(operation: string, workspace: WorkspaceRef, run: () => Promise<T>) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof SandboxProviderError) && !(error instanceof ThreadStoreError))
        logger.warn(
          { workspaceId: workspace.id, operation, ...publicErrorFields(error) },
          `Modal ${operation} failed`,
        );
      throw publicError(operation, error);
    }
  }

  return {
    resolve: (workspace, signal) =>
      guarded("resolve", workspace, async () => {
        const { located: _, ...resolution } = await resolveInternal(
          workspace,
          withProviderBudget(signal, timeoutMs),
        );

        return resolution;
      }),
    ensure: (workspace, signal) =>
      guarded("preparation", workspace, () =>
        ensure(workspace, withProviderBudget(signal, timeoutMs * 2 + exitSnapshotTimeoutMs)),
      ),
    exec,
    pause: (workspace, signal) =>
      lifecycle(
        workspace,
        "pause",
        withProviderBudget(signal, timeoutMs * 2 + exitSnapshotTimeoutMs),
      ),
    delete: (workspace, signal) =>
      lifecycle(
        workspace,
        "delete",
        withProviderBudget(signal, timeoutMs * 2 + exitSnapshotTimeoutMs),
      ),
  };
}
