import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import { user } from "../schema/auth";
import { attachment, message } from "../schema/threads";
import { ThreadStoreError, type AttachmentRecord, type ThreadStore } from "../thread-contracts";
import type { Db } from "./shared";

export const ATTACHMENT_FILE_MAX_BYTES = 25 * 1024 * 1024;

export const ATTACHMENT_MODEL_MAX_BYTES = 3 * 1024 * 1024;

export const ATTACHMENT_ACCOUNT_MAX_BYTES = 500 * 1024 * 1024;

export const ATTACHMENT_MESSAGE_MAX_BYTES = 50 * 1024 * 1024;

export const ATTACHMENT_MESSAGE_MAX_FILES = 10;

const pendingReservationBytes = ATTACHMENT_FILE_MAX_BYTES + ATTACHMENT_MODEL_MAX_BYTES;

export function safeAttachmentFilename(filename: string): string {
  const basename = filename.replaceAll("\\", "/").split("/").at(-1) ?? "";

  const safe = basename
    .normalize("NFKC")
    // eslint-disable-next-line no-control-regex -- Filenames cannot retain ASCII control bytes.
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .replace(/^\.+$/, "attachment")
    .trim();

  let bounded = "";
  let bytes = 0;

  for (const character of safe || "attachment") {
    const nextBytes = Buffer.byteLength(character, "utf8");

    if (bytes + nextBytes > 200) break;
    bounded += character;
    bytes += nextBytes;
  }

  return bounded || "attachment";
}

export function publicAttachment(attachment: AttachmentRecord) {
  return {
    id: attachment.id,
    filename: attachment.filename,
    detectedMimeType: attachment.detectedMimeType,
    classification: attachment.classification,
    size: attachment.originalSize,
    modelMimeType: attachment.modelMimeType,
    modelSize: attachment.modelSize,
    modelWidth: attachment.modelWidth,
    modelHeight: attachment.modelHeight,
  };
}

export function createAttachmentsStore(
  db: Db,
): Pick<
  ThreadStore,
  | "reserveAttachment"
  | "completeAttachment"
  | "failAttachment"
  | "readOwnedAttachment"
  | "beginDeleteAttachment"
  | "finishDeleteAttachment"
  | "claimExpiredAttachments"
  | "attachmentsForRun"
  | "listThreadAttachments"
> {
  return {
    async reserveAttachment(input) {
      return db.transaction(async (tx) => {
        const [owner] = await tx
          .select({ id: user.id })
          .from(user)
          .where(eq(user.id, input.userId))
          .for("update")
          .limit(1);

        if (!owner) throw new ThreadStoreError("UNAUTHORIZED", "Authentication required", 401);

        const [usage] = await tx
          .select({ bytes: sql<number>`coalesce(sum(${attachment.storageBytes}), 0)::int` })
          .from(attachment)
          .where(eq(attachment.userId, input.userId));

        if ((usage?.bytes ?? 0) + pendingReservationBytes > ATTACHMENT_ACCOUNT_MAX_BYTES)
          throw new ThreadStoreError(
            "ATTACHMENT_QUOTA_EXCEEDED",
            "Stored attachment allowance exceeded",
            409,
          );

        const [created] = await tx
          .insert(attachment)
          .values({
            ...input,
            state: "uploading",
            storageBytes: pendingReservationBytes,
          })
          .returning();

        if (!created)
          throw new ThreadStoreError(
            "ATTACHMENT_CREATE_FAILED",
            "Could not create attachment",
            500,
          );

        return created;
      });
    },

    async completeAttachment(input) {
      const [completed] = await db
        .update(attachment)
        .set({
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
        })
        .where(
          and(
            eq(attachment.id, input.id),
            eq(attachment.userId, input.userId),
            eq(attachment.state, "uploading"),
            isNull(attachment.messageId),
          ),
        )
        .returning();

      if (!completed)
        throw new ThreadStoreError(
          "ATTACHMENT_STATE",
          "Attachment upload is no longer active",
          409,
        );

      return completed;
    },

    async failAttachment({ id, userId }) {
      await db
        .update(attachment)
        .set({ state: "failed", updatedAt: new Date() })
        .where(
          and(eq(attachment.id, id), eq(attachment.userId, userId), isNull(attachment.messageId)),
        );
    },

    async readOwnedAttachment({ id, userId }) {
      const [owned] = await db
        .select()
        .from(attachment)
        .where(and(eq(attachment.id, id), eq(attachment.userId, userId)))
        .limit(1);

      if (!owned) throw new ThreadStoreError("ATTACHMENT_NOT_FOUND", "Attachment not found", 404);

      return owned;
    },

    async beginDeleteAttachment({ id, userId }) {
      return db.transaction(async (tx) => {
        const [owned] = await tx
          .select()
          .from(attachment)
          .where(and(eq(attachment.id, id), eq(attachment.userId, userId)))
          .for("update")
          .limit(1);

        if (!owned) throw new ThreadStoreError("ATTACHMENT_NOT_FOUND", "Attachment not found", 404);

        if (owned.messageId)
          throw new ThreadStoreError(
            "ATTACHMENT_BOUND",
            "An attachment already used by a message cannot be deleted",
            409,
          );

        const [deleting] = await tx
          .update(attachment)
          .set({ state: "deleting", updatedAt: new Date() })
          .where(eq(attachment.id, id))
          .returning();

        if (!deleting)
          throw new ThreadStoreError("ATTACHMENT_STATE", "Attachment could not be deleted", 409);

        return deleting;
      });
    },

    async finishDeleteAttachment(id) {
      await db
        .delete(attachment)
        .where(and(eq(attachment.id, id), eq(attachment.state, "deleting")));
    },

    async claimExpiredAttachments(before, limit = 100) {
      return db.transaction(async (tx) => {
        const expired = await tx
          .select()
          .from(attachment)
          .where(
            and(
              isNull(attachment.messageId),
              lt(attachment.createdAt, before),
              inArray(attachment.state, ["uploading", "ready", "failed"]),
            ),
          )
          .orderBy(asc(attachment.createdAt))
          .limit(Math.min(Math.max(limit, 1), 500))
          .for("update", { skipLocked: true });

        if (!expired.length) return [];
        const ids = expired.map((item) => item.id);
        await tx
          .update(attachment)
          .set({ state: "deleting", updatedAt: new Date() })
          .where(inArray(attachment.id, ids));

        return expired.map((item) => ({ ...item, state: "deleting" as const }));
      });
    },

    async attachmentsForRun(runId) {
      return db
        .select({ attachment })
        .from(attachment)
        .innerJoin(message, eq(attachment.messageId, message.id))
        .where(eq(message.runId, runId))
        .orderBy(asc(attachment.ordinal))
        .then((rows) => rows.map((row) => row.attachment));
    },

    async listThreadAttachments(threadId) {
      return db
        .select({ attachment })
        .from(attachment)
        .innerJoin(message, eq(attachment.messageId, message.id))
        .where(eq(message.threadId, threadId))
        .orderBy(asc(message.createdAt), asc(attachment.ordinal))
        .then((rows) => rows.map((row) => row.attachment));
    },
  };
}
