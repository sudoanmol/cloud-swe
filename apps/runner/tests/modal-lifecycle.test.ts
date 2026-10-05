import { afterAll, beforeAll, expect, test } from "bun:test";
import { ModalClient } from "modal";
import { createIntegrationHarness, resultSchema } from "./integration-helpers.js";

// Paid end-to-end idle lifecycle: the app's own Temporal timers must stop
// every Modal sandbox it starts. Checks Modal directly, not only PostgreSQL.
const enabled =
  process.env.RUN_PAID_INTEGRATION_TESTS === "1" &&
  Boolean(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET);

const appName = process.env.MODAL_APP_NAME ?? "cloud-swe-workspaces";

let client: ModalClient | undefined;

function modal(): ModalClient {
  client ??= new ModalClient({ environment: process.env.MODAL_ENVIRONMENT });

  return client;
}

const harness = createIntegrationHarness({
  dbName: `cloud_swe_modal_${process.pid}`,
  portBase: 33_000,
  executionMode: "scripted",
  sandboxProvider: "modal",
  idlePauseMs: 10_000,
});

const workspaceIds = new Set<string>();

async function runningSandboxes(workspaceId: string): Promise<string[]> {
  const { appId } = await modal().apps.fromName(appName, { createIfMissing: true });
  const ids: string[] = [];

  for await (const sandbox of modal().sandboxes.list({
    appId,
    tags: { "cloud-swe.workspace-id": workspaceId },
  }))
    ids.push(sandbox.sandboxId);

  return ids;
}

async function finished(providerId: string): Promise<boolean> {
  return (await (await modal().sandboxes.fromId(providerId)).poll()) !== null;
}

if (enabled) {
  beforeAll(async () => {
    await harness.setup();
  }, 180_000);

  afterAll(async () => {
    await harness.cleanup();

    // Never leave a billed sandbox behind, even when an assertion failed.
    for (const workspaceId of workspaceIds)
      for (const id of await runningSandboxes(workspaceId))
        await (await modal().sandboxes.fromId(id)).terminate({ wait: true });
  }, 180_000);
}

test.skipIf(!enabled)(
  "idle pause stops the sandbox and a follow-up restores it",
  async () => {
    const cookie = await harness.signup(`modal-${process.pid}@example.com`);

    const submit = async (path: string, prompt: string, clientMessageId: string) => {
      const result = await harness.http(
        path,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt, clientMessageId }),
        },
        cookie,
      );

      expect(result.response.status, result.text).toBe(202);

      return resultSchema.parse(result.body);
    };

    const waitRun = (threadId: string, runId: string) =>
      harness.waitSnapshot(
        cookie,
        threadId,
        (item) => item.runs.some((run) => run.id === runId && run.status === "completed"),
        { timeoutMs: 180_000, label: `run ${runId} completed` },
      );

    const waitState = (threadId: string, state: string) =>
      harness.waitSnapshot(cookie, threadId, (item) => item.workspace?.state === state, {
        timeoutMs: 120_000,
        label: `workspace ${state}`,
      });

    const initial = await submit("/api/threads", "prepare a workspace", `modal-${process.pid}-1`);
    await waitRun(initial.threadId, initial.runId);
    const first = await harness.readWorkspaceRow(initial.threadId);

    if (!first?.provider_id) throw new Error("run did not persist a Modal sandbox id");
    workspaceIds.add(first.id);
    expect(first.provider).toBe("modal");
    expect(await runningSandboxes(first.id)).toEqual([first.provider_id]);

    await waitState(initial.threadId, "paused");
    expect(await finished(first.provider_id)).toBe(true);
    expect(await runningSandboxes(first.id)).toEqual([]);

    const followup = await submit(
      `/api/threads/${initial.threadId}/messages`,
      "continue in the restored workspace",
      `modal-${process.pid}-2`,
    );

    await waitRun(initial.threadId, followup.runId);
    const restored = await harness.readWorkspaceRow(initial.threadId);

    if (!restored?.provider_id) throw new Error("follow-up did not persist a Modal sandbox id");
    expect(restored.provider_id).not.toBe(first.provider_id);
    // A restore keeps the filesystem generation; only a replacement resets it.
    expect(restored.generation).toBe(first.generation);

    await waitState(initial.threadId, "paused");
    expect(await finished(restored.provider_id)).toBe(true);
    expect(await runningSandboxes(first.id)).toEqual([]);
  },
  600_000,
);
