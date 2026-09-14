import { expect, test } from "bun:test";
import type { AttachmentObjectStore } from "@cloud-swe/db/attachment-objects";
import { ThreadStoreError, type AttachmentRecord } from "@cloud-swe/db/thread-contracts";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import sharp from "sharp";

import type { AuthProvider } from "../src/context";
import { registerApiRoutes } from "../src/routes";
import type { AttachmentStore } from "../src/routers/attachments";
import type { ThreadRouteStore } from "../src/routers/thread";

const origin = "https://web.example.test";

function multipart(filename: string, bytes: Uint8Array, field = "file") {
  const boundary = `cloud-swe-${randomUUID()}`;

  return {
    headers: {
      origin,
      "x-csrf-protection": "1",
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.from(bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

function attachmentHarness() {
  const records = new Map<string, AttachmentRecord>();
  const objectBytes = new Map<string, Buffer>();

  const store: AttachmentStore = {
    async reserveAttachment(input) {
      const now = new Date();

      const record: AttachmentRecord = {
        id: randomUUID(),
        userId: input.userId,
        messageId: null,
        ordinal: null,
        filename: input.filename,
        detectedMimeType: input.detectedMimeType,
        classification: input.classification,
        state: "uploading",
        originalObjectKey: null,
        originalSha256: null,
        originalSize: null,
        modelObjectKey: null,
        modelSha256: null,
        modelMimeType: null,
        modelSize: null,
        modelWidth: null,
        modelHeight: null,
        storageBytes: 0,
        createdAt: now,
        updatedAt: now,
      };

      records.set(record.id, record);

      return record;
    },
    async completeAttachment(input) {
      const current = records.get(input.id);

      if (!current || current.userId !== input.userId) throw new Error("missing fixture");

      const completed: AttachmentRecord = {
        ...current,
        state: "ready",
        originalObjectKey: input.originalObjectKey,
        originalSha256: input.originalSha256,
        originalSize: input.originalSize,
        modelObjectKey: input.modelObjectKey ?? null,
        modelSha256: input.modelSha256 ?? null,
        modelMimeType: input.modelMimeType ?? null,
        modelSize: input.modelSize ?? null,
        modelWidth: input.modelWidth ?? null,
        modelHeight: input.modelHeight ?? null,
        storageBytes: input.originalSize + (input.modelSize ?? 0),
        updatedAt: new Date(),
      };

      records.set(completed.id, completed);

      return completed;
    },
    async failAttachment({ id }) {
      const current = records.get(id);

      if (current) records.set(id, { ...current, state: "failed", updatedAt: new Date() });
    },
    async readOwnedAttachment({ id, userId }) {
      const current = records.get(id);

      if (!current || current.userId !== userId)
        throw new ThreadStoreError("ATTACHMENT_NOT_FOUND", "Attachment not found", 404);

      return current;
    },
    async beginDeleteAttachment(input) {
      const current = await store.readOwnedAttachment(input);

      if (current.messageId)
        throw new ThreadStoreError("ATTACHMENT_BOUND", "Attachment is bound", 409);
      const deleting = { ...current, state: "deleting" as const, updatedAt: new Date() };
      records.set(deleting.id, deleting);

      return deleting;
    },
    async finishDeleteAttachment(id) {
      records.delete(id);
    },
    async claimExpiredAttachments() {
      return [];
    },
  };

  const objects: AttachmentObjectStore = {
    async put({ key, body }) {
      if (body instanceof Uint8Array) objectBytes.set(key, Buffer.from(body));
      else {
        const parts: Buffer[] = [];

        for await (const part of body) parts.push(Buffer.from(part));
        objectBytes.set(key, Buffer.concat(parts));
      }
    },
    async get(key) {
      const value = objectBytes.get(key);

      if (!value) throw new Error("missing object fixture");

      return (async function* () {
        yield value;
      })();
    },
    async delete(keys) {
      for (const key of keys) objectBytes.delete(key);
    },
  };

  return { store, objects, records, objectBytes };
}

async function createApp(options: {
  attachmentStore?: AttachmentStore;
  attachmentObjects?: AttachmentObjectStore;
  userId?: string;
  submit?: ThreadRouteStore["submitThread"];
}) {
  const auth: AuthProvider = {
    getSession: async () => ({
      user: { id: options.userId ?? "user-1", emailVerified: true },
      session: {},
    }),
    handler: async () => Response.json({ ok: true }),
  };

  const store: ThreadRouteStore = {
    submitThread: options.submit ?? (async () => ({ threadId: randomUUID(), runId: randomUUID() })),
    submitMessage: async () => ({ threadId: randomUUID(), runId: randomUUID() }),
    listThreads: async () => [],
    getThread: async () => {
      throw new Error("unused");
    },
    authorizeThread: async () => undefined,
    listEvents: async () => [],
    requestCancel: async () => undefined,
    listQuestionRequests: async () => [],
    answerQuestionRequest: async () => {
      throw new Error("unused");
    },
  };

  const app = Fastify({ logger: false });
  registerApiRoutes(app, {
    auth,
    store,
    attachmentStore: options.attachmentStore,
    attachmentObjects: options.attachmentObjects,
    trustedOrigins: [origin],
    nodeEnv: "test",
    allowUnverifiedCompute: true,
  });
  await app.ready();

  return app;
}

test("uploads, downloads, deletes, and submits ordered attachment IDs", async () => {
  const harness = attachmentHarness();
  let submittedIds: string[] | undefined;

  const app = await createApp({
    attachmentStore: harness.store,
    attachmentObjects: harness.objects,
    submit: async (input) => {
      submittedIds = input.attachmentIds;

      return { threadId: randomUUID(), runId: randomUUID() };
    },
  });

  const textUpload = await app.inject({
    method: "POST",
    url: "/api/attachments",
    ...multipart("../notes.txt", Buffer.from("hello attachment")),
  });

  expect(textUpload.statusCode).toBe(201);
  const text = textUpload.json<{ id: string; filename: string; classification: string }>();
  expect(text.filename).toBe("notes.txt");
  expect(text.classification).toBe("file");
  const downloaded = await app.inject({ method: "GET", url: `/api/attachments/${text.id}` });
  expect(downloaded.statusCode).toBe(200);
  expect(downloaded.body).toBe("hello attachment");
  expect(downloaded.headers["content-disposition"]).toContain("attachment;");
  expect(downloaded.headers["x-content-type-options"]).toBe("nosniff");

  const imageBytes = await sharp({
    create: { width: 4, height: 3, channels: 4, background: "red" },
  })
    .png()
    .toBuffer();

  const imageUpload = await app.inject({
    method: "POST",
    url: "/api/attachments",
    ...multipart("image.dat", imageBytes),
  });

  expect(imageUpload.statusCode).toBe(201);

  const image = imageUpload.json<{
    id: string;
    classification: string;
    detectedMimeType: string;
    modelMimeType: string;
  }>();

  expect(image).toMatchObject({
    classification: "image",
    detectedMimeType: "image/png",
    modelMimeType: "image/webp",
  });
  expect(harness.objectBytes.size).toBe(3);

  const submitted = await app.inject({
    method: "POST",
    url: "/api/threads",
    headers: { origin, "x-csrf-protection": "1", "content-type": "application/json" },
    payload: { prompt: "", clientMessageId: "image-only", attachmentIds: [image.id, text.id] },
  });

  expect(submitted.statusCode).toBe(202);
  expect(submittedIds).toEqual([image.id, text.id]);

  expect(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/attachments/${text.id}`,
        headers: { origin, "x-csrf-protection": "1" },
      })
    ).statusCode,
  ).toBe(204);
  expect((await app.inject({ method: "GET", url: `/api/attachments/${text.id}` })).statusCode).toBe(
    404,
  );
  await app.close();
});

test("rejects corrupt images, invalid multipart, oversized files, and foreign reads", async () => {
  const harness = attachmentHarness();

  const app = await createApp({
    attachmentStore: harness.store,
    attachmentObjects: harness.objects,
  });

  const corrupt = await app.inject({
    method: "POST",
    url: "/api/attachments",
    ...multipart("broken.png", Buffer.from("89504e470d0a1a0a00", "hex")),
  });

  expect(corrupt.statusCode).toBe(400);
  expect(corrupt.json()).toMatchObject({ error: { code: "INVALID_IMAGE" } });
  expect([...harness.records.values()].some((item) => item.state === "failed")).toBe(true);

  const oversized = await app.inject({
    method: "POST",
    url: "/api/attachments",
    ...multipart("large.bin", Buffer.alloc(25 * 1024 * 1024 + 1)),
  });

  expect(oversized.statusCode).toBe(413);
  expect(oversized.json()).toMatchObject({ error: { code: "ATTACHMENT_TOO_LARGE" } });

  const invalid = await app.inject({
    method: "POST",
    url: "/api/attachments",
    headers: { origin, "x-csrf-protection": "1", "content-type": "application/json" },
    payload: {},
  });

  expect(invalid.statusCode).toBe(400);
  expect(invalid.json()).toMatchObject({ error: { code: "INVALID_UPLOAD" } });

  const valid = await app.inject({
    method: "POST",
    url: "/api/attachments",
    ...multipart("private.txt", Buffer.from("private")),
  });

  expect(valid.statusCode).toBe(201);
  const id = valid.json<{ id: string }>().id;

  const foreign = await createApp({
    attachmentStore: harness.store,
    attachmentObjects: harness.objects,
    userId: "user-2",
  });

  expect((await foreign.inject({ method: "GET", url: `/api/attachments/${id}` })).statusCode).toBe(
    404,
  );
  await Promise.all([app.close(), foreign.close()]);
});

test("keeps text submissions available while attachment storage is unconfigured", async () => {
  let submissions = 0;

  const app = await createApp({
    submit: async () => {
      submissions += 1;

      return { threadId: randomUUID(), runId: randomUUID() };
    },
  });

  const headers = { origin, "x-csrf-protection": "1", "content-type": "application/json" };

  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/threads",
        headers,
        payload: { prompt: "text only", clientMessageId: "text-only" },
      })
    ).statusCode,
  ).toBe(202);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/threads",
        headers,
        payload: {
          prompt: "with file",
          clientMessageId: "missing-storage",
          attachmentIds: [randomUUID()],
        },
      })
    ).statusCode,
  ).toBe(503);
  expect(submissions).toBe(1);
  await app.close();
});
