import { boundedProviderCall } from "./sandbox.js";
import { Freestyle, FreestyleApiError, type VmData } from "freestyle";
import { setTimeout as delay } from "node:timers/promises";

export class TemporaryResourceError extends Error {}

export type TemporaryPurpose = "snapshot-builder" | "snapshot-validation";

const project = "cloud-swe";

const limits = {
  "snapshot-builder": { maxRunSeconds: 3600, maxRunTotalSeconds: 7200 },
  "snapshot-validation": { maxRunSeconds: 900, maxRunTotalSeconds: 1800 },
};

function owned(vm: VmData, purpose?: TemporaryPurpose, buildId?: string) {
  const metadata = vm.metadata;

  return (
    metadata["cloud-swe.project"] === project &&
    ["snapshot-builder", "snapshot-validation"].includes(metadata["cloud-swe.purpose"] ?? "") &&
    (!purpose || metadata["cloud-swe.purpose"] === purpose) &&
    (!buildId || metadata["cloud-swe.build"] === buildId) &&
    Number.isFinite(Date.parse(metadata["cloud-swe.expires"] ?? ""))
  );
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Only a typed SDK 404 confirms absence.
const missing = (error: unknown) => error instanceof FreestyleApiError && error.status === 404;

export function createSnapshotResources(client: Freestyle) {
  async function lookup(id: string) {
    try {
      return await boundedProviderCall({
        operation: "temporary VM lookup",
        signal: new AbortController().signal,
        timeoutMs: 30000,
        call: () => client.vms.get(id),
      });
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async function pause(id: string) {
    const initial = await lookup(id);

    if (!initial || initial.state === "paused" || initial.state === "stopped") return;
    await boundedProviderCall({
      operation: "temporary VM pause",
      signal: new AbortController().signal,
      timeoutMs: 30000,
      call: () => client.vms.ref(id).pause(),
    });

    for (let attempt = 0; attempt < 60; attempt++) {
      const vm = await lookup(id);

      if (!vm || vm.state === "paused" || vm.state === "stopped") return;
      await delay(500);
    }

    throw new TemporaryResourceError(`Temporary VM pause could not be confirmed: ${id}`);
  }

  async function cleanup(input: {
    id: string;
    purpose: TemporaryPurpose;
    buildId: string;
    keep: boolean;
  }) {
    const vm = await lookup(input.id);

    if (!vm) return;

    if (!owned(vm, input.purpose, input.buildId))
      throw new TemporaryResourceError(`Temporary VM ownership did not match: ${vm.id}`);

    if (input.keep && Date.parse(vm.metadata["cloud-swe.expires"] ?? "") > Date.now()) {
      await pause(vm.id);

      return;
    }

    try {
      await boundedProviderCall({
        operation: "temporary VM delete",
        signal: new AbortController().signal,
        timeoutMs: 30000,
        call: () => client.vms.ref(vm.id).delete(),
      });

      for (let attempt = 0; attempt < 60; attempt++) {
        if (!(await lookup(vm.id))) return;
        await delay(500);
      }

      throw new TemporaryResourceError("Deletion was not confirmed");
    } catch {
      let paused = false;

      try {
        await pause(vm.id);
        paused = true;
      } catch {
        paused = false;
      }

      throw new TemporaryResourceError(
        `Temporary VM cleanup failed: ${vm.id}; pause ${paused ? "confirmed" : "unconfirmed"}`,
      );
    }
  }

  return {
    cleanup,
    async sweep() {
      const inventory: VmData[] = [];

      for (let offset = 0; ; offset += 100) {
        const page = await boundedProviderCall({
          operation: "temporary VM inventory",
          signal: new AbortController().signal,
          timeoutMs: 30000,
          call: () => client.vms.list({ offset, limit: 100 }),
        });

        inventory.push(...page.vms);

        if (offset + page.vms.length >= page.totalCount) break;

        if (page.vms.length === 0)
          throw new TemporaryResourceError("Provider inventory was incomplete");
      }

      const unlabelled: string[] = [];

      for (const vm of inventory) {
        if (!owned(vm)) {
          unlabelled.push(vm.id);
          continue;
        }

        if (Date.parse(vm.metadata["cloud-swe.expires"] ?? "") > Date.now()) continue;
        const purpose = vm.metadata["cloud-swe.purpose"];
        const buildId = vm.metadata["cloud-swe.build"];

        if ((purpose === "snapshot-builder" || purpose === "snapshot-validation") && buildId)
          await cleanup({ id: vm.id, purpose, buildId, keep: false });
      }

      return { unlabelled };
    },
    async create(input: {
      slug: string;
      snapshotId: string;
      purpose: TemporaryPurpose;
      buildId: string;
      expiresAt: string;
    }) {
      if (!/^[a-zA-Z0-9-]{1,63}$/.test(input.buildId))
        throw new TemporaryResourceError("Invalid build ID");
      const expiry = Date.parse(input.expiresAt);

      if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 86400000)
        throw new TemporaryResourceError("Temporary resource expiry must be within 24 hours");
      const existing = await lookup(input.slug);

      if (existing) {
        if (!owned(existing, input.purpose, input.buildId))
          throw new TemporaryResourceError("Temporary VM identity is already in use");

        if (Date.parse(existing.metadata["cloud-swe.expires"] ?? "") <= Date.now())
          throw new TemporaryResourceError("Temporary VM expired");

        return existing.id;
      }

      try {
        const result = await boundedProviderCall({
          operation: "temporary VM create",
          signal: new AbortController().signal,
          timeoutMs: 30000,
          call: () =>
            client.vms.create({
              snapshotId: input.snapshotId,
              slug: input.slug,
              ...limits[input.purpose],
              ttlSeconds: Math.floor((expiry - Date.now()) / 1000),
              automaticRestart: false,
              autoDeleteSeconds: 86400,
              metadata: {
                "cloud-swe.project": project,
                "cloud-swe.purpose": input.purpose,
                "cloud-swe.build": input.buildId,
                "cloud-swe.expires": input.expiresAt,
              },
              firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] },
            }),
        });

        return result.vmId;
      } catch {
        const recovered = await lookup(input.slug);

        if (recovered && owned(recovered, input.purpose, input.buildId)) return recovered.id;
        throw new TemporaryResourceError(
          `Temporary VM creation is unconfirmed; reconcile slug ${input.slug} before retrying`,
        );
      }
    },
  };
}
