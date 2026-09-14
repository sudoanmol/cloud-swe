import fastifyMultipart from "@fastify/multipart";
import type { AttachmentObjectStore } from "@cloud-swe/db/attachment-objects";
import { publicFailure } from "@cloud-swe/db/public-failure";
import { ThreadStoreError, type ThreadStore } from "@cloud-swe/db/thread-contracts";
import {
  ATTACHMENT_FILE_MAX_BYTES,
  publicAttachment,
  safeAttachmentFilename,
} from "@cloud-swe/db/threads";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { z } from "zod";

import { logFailure, sendError, sendFailure } from "../http";
import { UserRateLimiter } from "../security";

const paramsSchema = z.object({ id: z.uuid() });

const modelImageMaxPixels = 40_000_000;

const modelImageMaxBytes = 3 * 1024 * 1024;

const modelImageTimeoutMs = 30_000;

export type AttachmentStore = Pick<
  ThreadStore,
  | "reserveAttachment"
  | "completeAttachment"
  | "failAttachment"
  | "readOwnedAttachment"
  | "beginDeleteAttachment"
  | "finishDeleteAttachment"
  | "claimExpiredAttachments"
>;

export interface AttachmentRouteOptions {
  store: AttachmentStore;
  objects?: AttachmentObjectStore;
  nodeEnv?: "development" | "test" | "production";
  allowUnverifiedCompute?: boolean;
  computeAccess?: (userId: string) => Promise<{ owner: boolean; trusted: boolean }>;
}

type DetectedAttachmentType = {
  classification: "image" | "file";
  detectedMimeType: string;
};

function detectType(header: Uint8Array) {
  const text = Buffer.from(header).toString("ascii");

  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff)
    return {
      classification: "image",
      detectedMimeType: "image/jpeg",
    } satisfies DetectedAttachmentType;

  if (Buffer.from(header.subarray(0, 8)).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return {
      classification: "image",
      detectedMimeType: "image/png",
    } satisfies DetectedAttachmentType;

  if (text.startsWith("GIF87a") || text.startsWith("GIF89a"))
    return {
      classification: "image",
      detectedMimeType: "image/gif",
    } satisfies DetectedAttachmentType;

  if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP")
    return {
      classification: "image",
      detectedMimeType: "image/webp",
    } satisfies DetectedAttachmentType;

  return {
    classification: "file",
    detectedMimeType: "application/octet-stream",
  } satisfies DetectedAttachmentType;
}

async function modelImage(path: string) {
  const processor = sharp(path, { limitInputPixels: modelImageMaxPixels, animated: false })
    .rotate()
    .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 90 });

  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      processor.destroy();
      reject(new ThreadStoreError("INVALID_IMAGE", "Image processing timed out", 400));
    }, modelImageTimeoutMs);
  });

  try {
    const output = await Promise.race([processor.toBuffer({ resolveWithObject: true }), timeout]);

    if (output.data.byteLength > modelImageMaxBytes)
      throw new ThreadStoreError("IMAGE_VARIANT_TOO_LARGE", "Processed image exceeds 3 MiB", 400);

    return output;
  } catch (error) {
    if (error instanceof ThreadStoreError) throw error;
    throw new ThreadStoreError("INVALID_IMAGE", "Image is corrupt or unsupported", 400);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function deleteObjects(objects: AttachmentObjectStore, keys: Array<string | null>) {
  await objects.delete(keys.flatMap((key) => (key ? [key] : [])));
}

type UploadFailure = { error: unknown };

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Multipart errors enter here and are projected through a validated code before the public-failure boundary.
function uploadFailure(error: unknown): UploadFailure {
  const code = z.object({ code: z.string() }).safeParse(error).data?.code;

  if (code === "FST_REQ_FILE_TOO_LARGE")
    return {
      error: new ThreadStoreError("ATTACHMENT_TOO_LARGE", "Attachment exceeds 25 MiB", 413),
    };

  if (
    code === "FST_PARTS_LIMIT" ||
    code === "FST_FILES_LIMIT" ||
    code === "FST_FIELDS_LIMIT" ||
    code === "FST_INVALID_MULTIPART_CONTENT_TYPE"
  )
    return {
      error: new ThreadStoreError(
        "INVALID_UPLOAD",
        "Upload exactly one file and no form fields",
        400,
      ),
    };

  return { error };
}

export async function cleanupExpiredAttachments(
  store: AttachmentStore,
  objects: AttachmentObjectStore,
  now = new Date(),
): Promise<void> {
  const expired = await store.claimExpiredAttachments(
    new Date(now.getTime() - 24 * 60 * 60 * 1000),
  );

  for (const item of expired) {
    try {
      await deleteObjects(objects, [item.originalObjectKey, item.modelObjectKey]);
      await store.finishDeleteAttachment(item.id);
    } catch {
      await store.failAttachment({ id: item.id, userId: item.userId });
    }
  }
}

export function registerAttachmentRoutes(
  routes: FastifyInstance,
  options: AttachmentRouteOptions,
): void {
  routes.register(async (attachmentRoutes) => {
    await attachmentRoutes.register(fastifyMultipart, {
      limits: { files: 1, fields: 0, parts: 1, fileSize: ATTACHMENT_FILE_MAX_BYTES },
    });

    const limiter = new UserRateLimiter({ max: 20, windowMs: 60_000 });
    const active = new Map<string, number>();

    attachmentRoutes.post("/api/attachments", async (request, reply) => {
      const userId = request.threadUserId;
      const objects = options.objects;

      if (!userId) return;

      if (!objects)
        return sendError(
          reply,
          503,
          "ATTACHMENT_STORAGE_UNAVAILABLE",
          "Attachment storage is not configured",
        );

      try {
        const access = await options.computeAccess?.(userId);

        const locallyTrusted =
          options.nodeEnv !== undefined &&
          options.nodeEnv !== "production" &&
          options.allowUnverifiedCompute === true;

        if (!access?.trusted && !locallyTrusted)
          return sendError(
            reply,
            403,
            "COMPUTE_ADMISSION_REQUIRED",
            "Sign in with GitHub before uploading files",
          );
      } catch (error) {
        return sendFailure(request, reply, error, 503);
      }

      const retryAfterMs = limiter.consume(userId);

      if (retryAfterMs !== null) {
        reply.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));

        return sendError(reply, 429, "RATE_LIMITED", "Too many upload requests");
      }

      if ((active.get(userId) ?? 0) >= 2)
        return sendError(reply, 429, "UPLOAD_CONCURRENCY_LIMIT", "Two uploads are already active");

      active.set(userId, (active.get(userId) ?? 0) + 1);
      let directory: string | undefined;
      let attachmentId: string | undefined;
      const writtenKeys: string[] = [];

      try {
        directory = await mkdtemp(join(tmpdir(), "cloud-swe-attachment-"));
        const path = join(directory, "upload");
        let filename: string | undefined;
        let size = 0;
        const hash = createHash("sha256");
        const file = await open(path, "wx", 0o600);

        try {
          for await (const part of request.parts()) {
            if (part.type !== "file" || filename)
              throw new ThreadStoreError(
                "INVALID_UPLOAD",
                "Upload exactly one file and no form fields",
                400,
              );
            filename = safeAttachmentFilename(part.filename);

            for await (const value of part.file) {
              const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
              size += chunk.byteLength;

              if (size > ATTACHMENT_FILE_MAX_BYTES)
                throw new ThreadStoreError(
                  "ATTACHMENT_TOO_LARGE",
                  "Attachment exceeds 25 MiB",
                  413,
                );
              hash.update(chunk);
              await file.write(chunk);
            }

            if (part.file.truncated)
              throw new ThreadStoreError("ATTACHMENT_TOO_LARGE", "Attachment exceeds 25 MiB", 413);
          }
        } finally {
          await file.close();
        }

        if (!filename) throw new ThreadStoreError("INVALID_UPLOAD", "Upload exactly one file", 400);

        const headerFile = await open(path, "r");
        const header = Buffer.alloc(16);
        const { bytesRead } = await headerFile.read(header, 0, header.length, 0);
        await headerFile.close();
        const detected = detectType(header.subarray(0, bytesRead));
        const reserved = await options.store.reserveAttachment({ userId, filename, ...detected });
        attachmentId = reserved.id;
        const originalSha256 = hash.digest("hex");
        const originalObjectKey = `attachments/${reserved.id}/original-${originalSha256}`;

        let variant:
          | {
              data: Buffer;
              info: { width: number; height: number };
              sha256: string;
              key: string;
            }
          | undefined;

        if (detected.classification === "image") {
          const output = await modelImage(path);
          const sha256 = createHash("sha256").update(output.data).digest("hex");
          variant = {
            data: output.data,
            info: { width: output.info.width, height: output.info.height },
            sha256,
            key: `attachments/${reserved.id}/model-${sha256}.webp`,
          };
        }

        await objects.put({
          key: originalObjectKey,
          body: createReadStream(path),
          size,
          contentType: detected.detectedMimeType,
          sha256: originalSha256,
        });
        writtenKeys.push(originalObjectKey);

        if (variant) {
          await objects.put({
            key: variant.key,
            body: variant.data,
            size: variant.data.byteLength,
            contentType: "image/webp",
            sha256: variant.sha256,
          });
          writtenKeys.push(variant.key);
        }

        const completed = await options.store.completeAttachment({
          id: reserved.id,
          userId,
          originalObjectKey,
          originalSha256,
          originalSize: size,
          modelObjectKey: variant?.key,
          modelSha256: variant?.sha256,
          modelMimeType: variant ? "image/webp" : undefined,
          modelSize: variant?.data.byteLength,
          modelWidth: variant?.info.width,
          modelHeight: variant?.info.height,
        });

        reply.status(201);

        return publicAttachment(completed);
      } catch (error) {
        if (attachmentId)
          await options.store.failAttachment({ id: attachmentId, userId }).catch(() => undefined);
        await objects.delete(writtenKeys).catch(() => undefined);
        const uploadError = uploadFailure(error).error;
        const failure = publicFailure(uploadError);
        logFailure(request, uploadError, "Attachment upload failed");
        reply.status(failure.statusCode);

        return { error: { code: failure.code, message: failure.message } };
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
        const remaining = (active.get(userId) ?? 1) - 1;

        if (remaining) active.set(userId, remaining);
        else active.delete(userId);
      }
    });

    attachmentRoutes.get("/api/attachments/:id", async (request, reply) => {
      const userId = request.threadUserId;
      const objects = options.objects;
      const params = paramsSchema.safeParse(request.params);

      if (!userId) return;

      if (!params.success) return sendError(reply, 400, "INVALID_PAYLOAD", "Invalid attachment id");

      if (!objects)
        return sendError(
          reply,
          503,
          "ATTACHMENT_STORAGE_UNAVAILABLE",
          "Attachment storage is not configured",
        );

      try {
        const item = await options.store.readOwnedAttachment({ id: params.data.id, userId });

        if (item.state !== "ready" || !item.originalObjectKey || item.originalSize === null)
          return sendError(reply, 409, "ATTACHMENT_NOT_READY", "Attachment is not ready");
        reply.headers({
          "Cache-Control": "private, no-store",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(item.filename)}`,
          "Content-Length": item.originalSize,
          "Content-Type": item.detectedMimeType,
          "X-Content-Type-Options": "nosniff",
        });

        return reply.send(Readable.from(await objects.get(item.originalObjectKey)));
      } catch (error) {
        return sendFailure(request, reply, error);
      }
    });

    attachmentRoutes.delete("/api/attachments/:id", async (request, reply) => {
      const userId = request.threadUserId;
      const objects = options.objects;
      const params = paramsSchema.safeParse(request.params);

      if (!userId) return;

      if (!params.success) return sendError(reply, 400, "INVALID_PAYLOAD", "Invalid attachment id");

      if (!objects)
        return sendError(
          reply,
          503,
          "ATTACHMENT_STORAGE_UNAVAILABLE",
          "Attachment storage is not configured",
        );

      let deletingId: string | undefined;

      try {
        const item = await options.store.beginDeleteAttachment({ id: params.data.id, userId });
        deletingId = item.id;
        await deleteObjects(objects, [item.originalObjectKey, item.modelObjectKey]);
        await options.store.finishDeleteAttachment(item.id);

        return reply.status(204).send();
      } catch (error) {
        if (deletingId)
          await options.store.failAttachment({ id: deletingId, userId }).catch(() => undefined);

        return sendFailure(request, reply, error);
      }
    });
  });
}
