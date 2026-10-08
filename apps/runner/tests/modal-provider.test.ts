import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "bun:test";
import pino from "pino";
import { loadRunnerConfig } from "../src/config.js";
import { createModalProvider } from "../src/modal.js";
import type { SandboxProvider, WorkspaceRef } from "../src/sandbox.js";

// Live Modal lifecycle. Each case uses a few seconds of sandbox time from the
// published MODAL_IMAGE_NAME, so it runs only with the paid suite.
const config = loadRunnerConfig();

const enabled = process.env.RUN_PAID_INTEGRATION_TESTS === "1" && Boolean(config.modal);

const provider: SandboxProvider | undefined = enabled
  ? createModalProvider({ ...config, sandboxProvider: "modal" }, pino({ enabled: false }))
  : undefined;

const created: WorkspaceRef[] = [];

const signal = () => AbortSignal.timeout(180_000);

function workspace(): WorkspaceRef {
  const id = randomUUID();

  const ref: WorkspaceRef = {
    id,
    threadId: randomUUID(),
    name: `cloud-swe-test-${id}`,
    provider: "modal",
    providerId: null,
    generation: 1,
  };

  created.push(ref);

  return ref;
}

function live(): SandboxProvider {
  if (!provider) throw new Error("Modal provider is not configured");

  return provider;
}

async function run(ref: WorkspaceRef, command: string, stdin?: string) {
  return await live().exec(ref, { command, stdin, timeoutMs: 30_000 }, signal());
}

afterAll(async () => {
  for (const ref of created) await provider?.delete(ref, signal()).catch(() => undefined);
}, 180_000);

test.skipIf(!enabled)(
  "pause keeps files, restore starts a new sandbox, and stale ids resolve by name",
  async () => {
    const initial = workspace();
    const first = await live().ensure(initial, signal());
    expect(first.disposition).toBe("created");
    let ref = { ...initial, providerId: first.providerId };

    const written = await run(
      ref,
      "cat > /workspace/kept.txt; (sleep 600 >/dev/null 2>&1 &); echo started",
      "kept",
    );

    expect(written).toMatchObject({ kind: "completed", stdout: "started\n" });
    expect(await run(ref, "exit 7")).toMatchObject({ kind: "failed", statusCode: 7 });

    expect(await live().ensure(ref, signal())).toMatchObject({
      disposition: "existing",
      providerId: first.providerId,
    });
    // A running sandbox reports its hard deadline; a paused one has none.
    expect((await live().resolve(ref, signal())).expiresAt).toBeGreaterThan(Date.now());

    expect(await live().pause(ref, signal())).toMatchObject({
      outcome: "completed",
      providerId: first.providerId,
    });
    expect(await live().resolve(ref, signal())).toMatchObject({
      disposition: "present",
      expiresAt: undefined,
    });

    const restored = await live().ensure(ref, signal());
    expect(restored).toMatchObject({
      disposition: "restored",
      previousProviderId: first.providerId,
    });
    expect(restored.providerId).not.toBe(first.providerId);

    // A lost providerId update after the restore still finds the same lineage.
    const stale = await live().resolve(ref, signal());
    expect(stale).toMatchObject({ disposition: "present", recovered: true });
    expect(stale.workspace.providerId).toBe(restored.providerId);

    ref = { ...ref, providerId: restored.providerId };
    expect(await run(ref, "cat /workspace/kept.txt")).toMatchObject({ stdout: "kept" });
    // Processes do not survive a pause.
    expect(await run(ref, "pgrep -x sleep || echo none")).toMatchObject({
      stdout: "none\n",
    });

    // ensure returns before Docker finishes starting; runs wait in the environment probe.
    const docker = await run(
      ref,
      "timeout 30 sh -c 'until docker info >/dev/null 2>&1; do sleep 0.2; done' && docker run --rm hello-world >/dev/null && echo docker-ok",
    );

    expect(docker).toMatchObject({ kind: "completed", stdout: "docker-ok\n" });
  },
  300_000,
);

test.skipIf(!enabled)(
  "delete removes the filesystem and the next ensure replaces it",
  async () => {
    const initial = workspace();
    const first = await live().ensure(initial, signal());
    const ref = { ...initial, providerId: first.providerId };
    await run(ref, "echo gone > /workspace/gone.txt");

    expect(await live().delete(ref, signal())).toMatchObject({ outcome: "completed" });

    const replacement = await live().ensure(ref, signal());
    expect(replacement).toMatchObject({
      disposition: "replaced",
      previousProviderId: first.providerId,
    });
    const next = { ...ref, providerId: replacement.providerId };
    expect(await run(next, "test -e /workspace/gone.txt || echo missing")).toMatchObject({
      stdout: "missing\n",
    });
  },
  300_000,
);
