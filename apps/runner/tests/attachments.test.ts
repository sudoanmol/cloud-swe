import { expect, test } from "bun:test";
import type { AttachmentObjectStore } from "@cloud-swe/db/attachment-objects";
import type { AttachmentRecord } from "@cloud-swe/db/thread-contracts";
import { createHash, randomUUID } from "node:crypto";

import {
  attachmentImageReferences,
  attachmentManifest,
  checkpointAttachmentIds,
  hydrateCheckpointEntries,
  materializeAttachments,
  promptImages,
} from "../src/attachments.js";
import { processResult } from "../src/sandbox.js";

function record(
  input: Partial<AttachmentRecord> & Pick<AttachmentRecord, "classification" | "filename">,
): AttachmentRecord {
  const now = new Date();

  return {
    id: randomUUID(),
    userId: "user-1",
    messageId: randomUUID(),
    ordinal: 0,
    detectedMimeType: input.classification === "image" ? "image/png" : "application/octet-stream",
    state: "ready",
    originalObjectKey: "original",
    originalSha256: "a".repeat(64),
    originalSize: 0,
    modelObjectKey: null,
    modelSha256: null,
    modelMimeType: null,
    modelSize: null,
    modelWidth: null,
    modelHeight: null,
    storageBytes: 0,
    createdAt: now,
    updatedAt: now,
    ...input,
  };
}

function objects(
  values: Map<string, Buffer>,
  onGet?: (key: string) => void,
): AttachmentObjectStore {
  return {
    async put() {},
    async get(key) {
      onGet?.(key);
      const value = values.get(key);

      if (!value) throw new Error("missing fixture");

      return (async function* () {
        yield value.subarray(0, 17);
        yield value.subarray(17);
      })();
    },
    async delete() {},
  };
}

test("materializes binary originals in bounded chunks and preserves verified files", async () => {
  const bytes = Buffer.alloc(300_000, 0xa5);

  const item = record({
    classification: "file",
    filename: "../../payload.bin",
    originalObjectKey: "original-1",
    originalSha256: createHash("sha256").update(bytes).digest("hex"),
    originalSize: bytes.byteLength,
    storageBytes: bytes.byteLength,
  });

  const written: Buffer[] = [];
  let commands = 0;
  let gets = 0;

  await materializeAttachments(
    [item],
    objects(new Map([["original-1", bytes]]), () => {
      gets += 1;
    }),
    async (request) => {
      commands += 1;

      if (commands === 1) return processResult("upload\n", "", 0);

      if (request.stdin) {
        const chunk = Buffer.from(request.stdin, "base64");
        expect(chunk.byteLength).toBeLessThanOrEqual(128 * 1024);
        written.push(chunk);
      }

      return processResult("", "", 0);
    },
  );
  expect(Buffer.concat(written)).toEqual(bytes);
  expect(gets).toBe(1);
  expect(attachmentManifest([item])).toContain(`/workspace/.attachments/${item.id}/payload.bin`);

  await materializeAttachments(
    [item],
    objects(new Map(), () => {
      gets += 1;
    }),
    async () => processResult("existing\n", "", 0),
  );
  expect(gets).toBe(1);
});

test("hydrates owned checkpoint references and rejects stale ownership", async () => {
  const bytes = Buffer.from("model image");

  const image = record({
    classification: "image",
    filename: "image.png",
    originalSize: 50,
    modelObjectKey: "model-1",
    modelSha256: createHash("sha256").update(bytes).digest("hex"),
    modelMimeType: "image/webp",
    modelSize: bytes.byteLength,
    modelWidth: 10,
    modelHeight: 10,
    storageBytes: 50 + bytes.byteLength,
  });

  const [reference] = attachmentImageReferences([image]);

  if (!reference) throw new Error("Missing reference fixture");

  const checkpoint = {
    version: 2 as const,
    sessionId: "session-1",
    provider: "test-provider",
    model: "test-model",
    entries: [
      {
        type: "session" as const,
        version: 3 as const,
        id: "session-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/workspace",
      },
      {
        type: "message" as const,
        id: "user-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user" as const, content: [reference], timestamp: 1 },
      },
    ],
  };

  const storage = objects(new Map([["model-1", bytes]]));

  const hydrated = await hydrateCheckpointEntries({
    checkpoint,
    attachments: [image],
    objects: storage,
    userId: image.userId,
  });

  expect(JSON.stringify(hydrated)).toContain(bytes.toString("base64"));
  expect(checkpointAttachmentIds(checkpoint)).toEqual(new Set([image.id]));
  expect(await promptImages([image], storage)).toEqual([
    { type: "image", data: bytes.toString("base64"), mimeType: "image/webp" },
  ]);
  await expect(
    hydrateCheckpointEntries({
      checkpoint,
      attachments: [{ ...image, userId: "other-user" }],
      objects: storage,
      userId: "user-1",
    }),
  ).rejects.toMatchObject({ code: "ATTACHMENT_REFERENCE_INVALID" });
});
