/**
 * Path: server/src/sessions/attachments.ts
 * Used by: server/src/sessions/{messages,models,routes,thread,transcript}.ts.
 * Purpose: A session's image attachments: two files each in R2 (the model copy and the optional original), small rows in the Thread that name them, a message's image input as placeholders, and the swap of placeholders for the model copies' public bucket addresses in each model request.
 */

import { Buffer } from 'node:buffer';

import type { ContentBlock } from '@cloud-swe/protocol';
import { Attachment, type ImageMediaType } from '@cloud-swe/protocol/attachments';
import { NativeImageMessage } from '@cloud-swe/protocol/native';
import {
  StoredAttachment,
  type StoredImageFile,
  StoredUploads,
  UNSENT_UPLOAD_LIMIT,
} from '@cloud-swe/protocol/storage';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import type { EntryRecord, InputEntry } from '@earendil-works/pi-durable';
import { z } from 'zod';

import type { Env } from '../env.ts';
import { apiError, failure, respond, type Result, success } from '../errors.ts';
import { type KvReader, readParsed } from '../storage.ts';

// Not `pi.*`: an application kind. A user message with images is placed as it, with data naming each image's attachment.
const IMAGE_MESSAGE_KIND = 'cloud-swe.user';

// What Pi's image content holds for an attachment instead of base64. `:` is not a base64 character, so no tool image
// can look like one.
const PLACEHOLDER = 'attachment:';

export type AttachmentFile = 'model' | 'original';

type MediaType = z.output<typeof ImageMediaType>;

type AttachmentHost = {
  env: Pick<Env, 'ATTACHMENTS' | 'ATTACHMENTS_PUBLIC_URL'>;
  storage: DurableObjectStorage;
};

const attachmentKey = (id: string) => `attachment:${id}`;

const waitingIds = async (storage: KvReader) => (await readParsed(storage, 'uploads', StoredUploads))?.ids ?? [];

const keysOf = (attachment: StoredAttachment | undefined) =>
  [attachment?.model?.key, attachment?.original?.key].filter((key) => key !== undefined);

type Size = { width: number; height: number } | undefined;

const sized = (width: number, height: number): Size => (width > 0 && height > 0 ? { width, height } : undefined);

const asciiAt = (bytes: Uint8Array, offset: number, text: string) =>
  Buffer.from(bytes.subarray(offset, offset + text.length)).toString('latin1') === text;

function webpSize(bytes: Uint8Array, view: DataView): Size {
  if (!asciiAt(bytes, 0, 'RIFF') || !asciiAt(bytes, 8, 'WEBP')) return undefined;

  if (asciiAt(bytes, 12, 'VP8 ')) return sized(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);

  if (asciiAt(bytes, 12, 'VP8L')) {
    const bits = view.getUint32(21, true);

    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }

  if (!asciiAt(bytes, 12, 'VP8X')) return undefined;

  return sized((view.getUint32(24, true) & 0xff_ff_ff) + 1, (view.getUint32(27, true) & 0xff_ff_ff) + 1);
}

function jpegSize(view: DataView): Size {
  if (view.getUint16(0) !== 0xff_d8) return undefined;

  for (let offset = 2; offset + 9 <= view.byteLength;) {
    const marker = view.getUint8(offset + 1);

    if (view.getUint8(offset) !== 0xff) return undefined;

    if (marker === 0xff) {
      offset++;
      continue;
    }

    // SOF0 to SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return sized(view.getUint16(offset + 7), view.getUint16(offset + 5));
    }

    offset += 2 + view.getUint16(offset + 2);
  }

  return undefined;
}

/**
 * The width and height an image's header declares, read without decoding it, or undefined when the bytes are not an
 * image of `mediaType`: PNG's IHDR, GIF's screen, WebP's VP8, VP8L or VP8X chunk, JPEG's first SOF segment.
 */
export function imageSize(bytes: Uint8Array, mediaType: MediaType): Size {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  try {
    switch (mediaType) {
      case 'image/png':
        return view.getUint32(0) === 0x89_50_4e_47 && asciiAt(bytes, 12, 'IHDR')
          ? sized(view.getUint32(16), view.getUint32(20))
          : undefined;
      case 'image/gif':
        return asciiAt(bytes, 0, 'GIF8') ? sized(view.getUint16(6, true), view.getUint16(8, true)) : undefined;
      case 'image/webp':
        return webpSize(bytes, view);
      case 'image/jpeg':
        return jpegSize(view);
    }
  } catch {
    // A header cut short reads past the end.
    return undefined;
  }
}

/**
 * Stores one file of an upload the route has checked: into R2 under a key of its own, then its row in the Thread,
 * which keeps the first file stored under the ID and deletes this one if it lost to it.
 */
export async function storeFile(
  env: Pick<Env, 'ATTACHMENTS'>,
  thread: { recordUpload(id: string, file: AttachmentFile, stored: StoredImageFile): Promise<Response> },
  { sessionId, attachmentId }: { sessionId: string; attachmentId: string },
  file: AttachmentFile,
  mediaType: MediaType,
  body: ReadableStream | ArrayBuffer,
): Promise<Response> {
  const key = `${sessionId}/${attachmentId}/${file}/${crypto.randomUUID()}`;
  const object = await env.ATTACHMENTS.put(key, body, { httpMetadata: { contentType: mediaType } });

  try {
    // R2 includes the MD5 of every object that is not a multipart upload.
    const md5 = object?.checksums.md5;

    if (!object || !md5) throw new Error('R2 stored an upload without its MD5');

    return await thread.recordUpload(attachmentId, file, {
      key,
      mediaType,
      bytes: object.size,
      md5: Buffer.from(md5).toString('hex'),
    });
  } catch (error) {
    await env.ATTACHMENTS.delete(key);
    throw error;
  }
}

/**
 * Records a file just stored in R2, or answers a retry: the same type and bytes under the ID are the same upload
 * (200), others a conflict, and either way the new copy is deleted. A new attachment past UNSENT_UPLOAD_LIMIT removes
 * the oldest unsent one with its files, so an abandoned draft never blocks a new upload.
 */
export async function recordUpload(
  host: AttachmentHost,
  id: string,
  file: AttachmentFile,
  stored: StoredImageFile,
): Promise<Response> {
  const { existing, removed } = await host.storage.transaction(async (tx) => {
    const saved = await readParsed(tx, attachmentKey(id), StoredAttachment);
    const kept = saved?.[file];

    if (kept) return { existing: kept, removed: [stored.key] };
    const evicted: string[] = [];

    if (!saved) {
      const waiting = [...(await waitingIds(tx)), id];

      evicted.push(...waiting.splice(0, Math.max(0, waiting.length - UNSENT_UPLOAD_LIMIT)));
      await tx.put('uploads', StoredUploads.parse({ ids: waiting }));
    }

    const files = await Promise.all(
      evicted.map(async (old) => keysOf(await readParsed(tx, attachmentKey(old), StoredAttachment))),
    );

    await tx.delete(evicted.map(attachmentKey));
    await tx.put(attachmentKey(id), StoredAttachment.parse({ ...saved, sent: saved?.sent ?? false, [file]: stored }));

    return { existing: undefined, removed: files.flat() };
  });

  if (removed.length > 0) await host.env.ATTACHMENTS.delete(removed);

  if (!existing)
    return respond(success(Attachment.parse({ id, mediaType: stored.mediaType, bytes: stored.bytes })), 201);

  if (existing.md5 !== stored.md5 || existing.mediaType !== stored.mediaType) return apiError('operation_conflict');

  return respond(success(Attachment.parse({ id, mediaType: existing.mediaType, bytes: existing.bytes })));
}

/** Where a file of the attachment is in R2. */
export async function storedFile(
  storage: KvReader,
  id: string,
  file: AttachmentFile,
): Promise<Result<StoredImageFile>> {
  const stored = (await readParsed(storage, attachmentKey(id), StoredAttachment))?.[file];

  return stored ? success(stored) : failure('attachment_not_found');
}

/** A file's bytes from R2, which never change under an ID. */
export async function serveFile(env: Pick<Env, 'ATTACHMENTS'>, found: Result<StoredImageFile>): Promise<Response> {
  if (!found.ok) return respond(found);
  const object = await env.ATTACHMENTS.get(found.value.key);

  if (!object) return apiError('attachment_not_found');

  return new Response(object.body, {
    headers: {
      'Content-Type': found.value.mediaType,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * The model copy's address in the public bucket. Its random key is the only protection: anyone holding the address
 * can read the file, so it is never stored, logged or returned by an API. Stable, so the prompt cache keeps matching.
 */
export async function modelImageUrl(host: AttachmentHost, id: string): Promise<string> {
  const stored = await storedFile(host.storage, id, 'model');
  const base = host.env.ATTACHMENTS_PUBLIC_URL?.replace(/\/$/, '');

  if (!stored.ok || !base) throw new Error('An attachment the transcript names has no model URL');

  return `${base}/${stored.value.key}`;
}

const Placeholder = z.looseObject({
  type: z.literal('image'),
  source: z.object({ type: z.literal('base64'), data: z.string().startsWith(PLACEHOLDER) }),
});

const RequestBlock = z.looseObject({ type: z.string() });

/** The part of an Anthropic Messages request that holds images. */
export const AnthropicPayload = z.looseObject({
  messages: z.array(z.looseObject({ content: z.union([z.string(), z.array(RequestBlock)]) })),
});

type AnthropicPayload = z.output<typeof AnthropicPayload>;

/**
 * The request with each attachment's image pointing at its model copy's URL instead of a placeholder, keeping the
 * block's other fields (its cache marker). Tool images carry real base64 and stay as they are.
 */
export async function linkImages(
  payload: AnthropicPayload,
  url: (id: string) => Promise<string>,
): Promise<AnthropicPayload> {
  const link = async (block: z.output<typeof RequestBlock>) => {
    const image = Placeholder.safeParse(block);

    if (!image.success) return block;

    return { ...image.data, source: { type: 'url', url: await url(image.data.source.data.slice(PLACEHOLDER.length)) } };
  };

  const messages = await Promise.all(
    payload.messages.map(async (message) =>
      Array.isArray(message.content) ? { ...message, content: await Promise.all(message.content.map(link)) } : message,
    ),
  );

  return { ...payload, messages };
}

/**
 * What Pi gets for a message: its text, then a placeholder per image, placed as an entry that names them. Each named
 * attachment is marked sent in the same transaction, so it is never evicted: every later model request fetches it
 * again. Undefined when an attachment is not one of this session's or has no model copy.
 */
export async function messageInput(
  host: { storage: DurableObjectStorage },
  text: string,
  attachments: readonly string[] = [],
): Promise<{ content: string | (TextContent | ImageContent)[]; entry?: InputEntry } | undefined> {
  if (attachments.length === 0) return { content: text };

  const images = await host.storage.transaction(async (tx) => {
    const found: { id: string; mediaType: MediaType; saved: StoredAttachment }[] = [];

    for (const id of attachments) {
      const saved = await readParsed(tx, attachmentKey(id), StoredAttachment);

      if (!saved?.model) return undefined;
      found.push({ id, mediaType: saved.model.mediaType, saved });
    }

    const waiting = await waitingIds(tx);

    await tx.put({
      ...Object.fromEntries(
        found.map(({ id, saved }) => [attachmentKey(id), StoredAttachment.parse({ ...saved, sent: true })]),
      ),
      uploads: StoredUploads.parse({ ids: waiting.filter((id) => !attachments.includes(id)) }),
    });

    return found;
  });

  if (!images) return undefined;

  return {
    content: [
      { type: 'text', text },
      ...images.map(({ id, mediaType }): ImageContent => ({
        type: 'image',
        data: PLACEHOLDER + id,
        mimeType: mediaType,
      })),
    ],
    entry: { kind: IMAGE_MESSAGE_KIND, data: { attachments: images.map(({ id, mediaType }) => ({ id, mediaType })) } },
  };
}

/** A user message's images as content blocks that name their attachments. */
export function imageBlocks(record: EntryRecord): ContentBlock[] {
  const named = record.kind === IMAGE_MESSAGE_KIND ? NativeImageMessage.safeParse(record.data) : undefined;

  return named?.success
    ? named.data.attachments.map(({ id, mediaType }) => ({ kind: 'image', attachmentId: id, mediaType }))
    : [];
}
