/**
 * Path: server/test/attachments.test.ts
 * Used by: pnpm test.
 * Purpose: Image attachments over HTTP: upload statuses, retries and conflicts for both files, the pixel check, the unsent-upload bound, a message whose images reach the model as public bucket addresses holding their exact bytes, every client seeing image blocks, downloads byte for byte, and no image bytes or URL in any response or stored row.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { ApiError, CancelRunResponse, type Entry, HistoryResponse, Snapshot } from '@cloud-swe/protocol';
import { ATTACHMENT_LIMITS, Attachment } from '@cloud-swe/protocol/attachments';
import { UNSENT_UPLOAD_LIMIT } from '@cloud-swe/protocol/storage';
import type { Response as WorkerResponse } from 'miniflare';
import { z } from 'zod';

import { lifecycleRig } from './lifecycle-rig.ts';
import { modelAnswer } from './model-answer.ts';
import { headers, model, storedText, threadDatabases, waitFor } from './rig.ts';

const auth = { Authorization: headers.Authorization };

const { modelEdge } = ATTACHMENT_LIMITS;

// The test Worker's ATTACHMENTS_PUBLIC_URL.
const PUBLIC_BASE = 'https://attachments.test';

// Images whose headers declare a size, followed by random bytes: the server reads only the header.
function png(width: number, height: number, padding = 1000) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);

  return Buffer.concat([header, randomBytes(padding)]);
}

function jpeg(width: number, height: number, padding = 1000) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0', 'latin1'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;

  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, randomBytes(padding)]);
}

function webp(width: number, height: number, padding = 1000) {
  const header = Buffer.alloc(30);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(22 + padding, 4);
  header.write('WEBP', 8, 'latin1');
  header.write('VP8X', 12, 'latin1');
  header.writeUInt32LE(10, 16);
  header.writeUIntLE(width - 1, 24, 3);
  header.writeUIntLE(height - 1, 27, 3);

  return Buffer.concat([header, randomBytes(padding)]);
}

function gif(width: number, height: number, padding = 1000) {
  const header = Buffer.alloc(13);
  header.write('GIF89a', 0, 'latin1');
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);

  return Buffer.concat([header, randomBytes(padding)]);
}

const UrlImage = z.object({
  type: z.literal('image'),
  source: z.strictObject({ type: z.literal('url'), url: z.url() }),
});

// A captured Anthropic request's messages; the one with images holds the text, then the images.
const ModelRequest = z.object({ messages: z.array(z.object({ content: z.unknown() })) });

const ImageMessage = z.tuple([z.object({ type: z.literal('text'), text: z.string() })], UrlImage);

type Rig = Awaited<ReturnType<typeof lifecycleRig>>;

const attachmentPath = (sessionId: string, id: string, original = false) =>
  `/v1/sessions/${sessionId}/attachments/${id}${original ? '/original' : ''}`;

function upload(rig: Rig, sessionId: string, id: string, body: BodyInit, type = 'image/png', original = false) {
  const init: RequestInit & { duplex?: 'half' } = {
    method: 'PUT',
    headers: { ...auth, 'Content-Type': type },
    body,
  };

  // A stream goes chunked, with no Content-Length for the limit to read up front.
  if (body instanceof ReadableStream) init.duplex = 'half';

  return fetch(new URL(attachmentPath(sessionId, id, original), rig.base()), init);
}

/**
 * An upload that declares `length` bytes and sends none. A body over the limit is refused by its Content-Length before
 * any of it is read, and a client still writing megabytes into that closed connection fails with EPIPE instead of
 * reading the answer.
 */
function declared(rig: Rig, sessionId: string, id: string, length: number, original = false) {
  return new Promise<globalThis.Response>((resolve, reject) => {
    const sent = request(new URL(attachmentPath(sessionId, id, original), rig.base()), {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'image/png', 'Content-Length': length },
    });

    sent.on('error', reject);
    sent.on('response', (response) => {
      const chunks: Buffer[] = [];

      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode }));
        sent.destroy();
      });
    });
    sent.flushHeaders();
  });
}

const download = (rig: Rig, sessionId: string, id: string, init: RequestInit = { headers: auth }, original = false) =>
  fetch(new URL(attachmentPath(sessionId, id, original), rig.base()), init);

async function errorCode(response: globalThis.Response) {
  return ApiError.parse(await response.json()).error.code;
}

async function assertDownloads(
  rig: Rig,
  sessionId: string,
  id: string,
  bytes: Uint8Array,
  mediaType: string,
  original = false,
) {
  const response = await download(rig, sessionId, id, { headers: auth }, original);

  assert.equal(response.status, 200, `download ${id}`);
  assert.equal(response.headers.get('Content-Type'), mediaType);
  assert.match(response.headers.get('Cache-Control') ?? '', /^private, .*immutable/);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(bytes), `the bytes of ${id} come back unchanged`);
}

const objectKeys = async (rig: Rig, prefix = '') =>
  (await (await rig.attachments()).list({ prefix })).objects.map(({ key }) => key);

// A body bigger than `limit` sent chunked, so the limit counts it as it arrives.
function chunked(limit: number) {
  const chunk = randomBytes(256 * 1024);
  let left = Math.ceil(limit / chunk.length) + 1;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (left-- > 0) controller.enqueue(chunk);
      else controller.close();
    },
  });
}

test('uploads: sign-in, the 404 first, type, size and pixel refusals, both files, retries and conflicts', async () => {
  const rig = await lifecycleRig();

  try {
    const image = png(800, 600);
    const unknownSession = crypto.randomUUID();
    const id = crypto.randomUUID();

    // An unknown session: 404 before any refusal, and neither its Thread nor R2 stores anything.
    for (const response of [
      await upload(rig, unknownSession, id, image),
      await upload(rig, unknownSession, id, image, 'image/png', true),
      await upload(rig, unknownSession, id, image, 'text/plain'),
      await upload(rig, unknownSession, id, randomBytes(1000)),
      await upload(rig, unknownSession, id, png(modelEdge + 1, 10)),
      await declared(rig, unknownSession, id, ATTACHMENT_LIMITS.modelBytes + 1),
      await download(rig, unknownSession, id),
      await download(rig, unknownSession, id, { headers: auth }, true),
      await rig.api(`/v1/sessions/${unknownSession}/conversations/1/messages`, {
        operationId: crypto.randomUUID(),
        text: 'look',
        attachments: [id],
      }),
    ]) {
      assert.equal(response.status, 404);
      assert.equal(await errorCode(response), 'session_not_found');
    }

    const databases = (await threadDatabases(rig.storage)).filter((path) => !path.endsWith('metadata.sqlite'));
    assert.equal(databases.length, 1);
    const database = new DatabaseSync(databases[0] ?? '', { readOnly: true });

    try {
      const tables = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all();
      assert.deepEqual(
        tables.map(({ name }) => name),
        ['__miniflare_do_name'],
      );
    } finally {
      database.close();
    }

    assert.deepEqual(await objectKeys(rig), []);

    const session = await rig.create();

    // Sign-in comes first on every route.
    for (const original of [false, true]) {
      const unsigned = await fetch(new URL(attachmentPath(session.id, id, original), rig.base()), {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: image,
      });

      assert.equal(unsigned.status, 401);
      assert.equal((await download(rig, session.id, id, {}, original)).status, 401);
    }

    assert.equal((await upload(rig, session.id, 'not-a-uuid', image)).status, 400);
    assert.equal((await upload(rig, session.id, id, new Uint8Array())).status, 400);
    assert.equal((await upload(rig, session.id, id, new Uint8Array(), 'image/png', true)).status, 400);

    for (const type of ['text/plain', 'image/svg+xml', 'image/heic']) {
      const refused = await upload(rig, session.id, id, image, type);
      assert.equal(refused.status, 415, type);
      assert.equal(await errorCode(refused), 'attachment_type_unsupported');
    }

    // A model copy must be an image of its type, read from its header.
    for (const [bytes, type] of [
      [randomBytes(1000), 'image/png'],
      [image, 'image/jpeg'],
      [image.subarray(0, 20), 'image/png'],
    ] as const) {
      const refused = await upload(rig, session.id, id, bytes, type);
      assert.equal(refused.status, 415, type);
      assert.equal(await errorCode(refused), 'attachment_type_unsupported');
    }

    for (const [bytes, type] of [
      [png(modelEdge + 1, 10), 'image/png'],
      [jpeg(10, modelEdge + 1), 'image/jpeg'],
      [webp(modelEdge + 1, 1), 'image/webp'],
      [gif(1, modelEdge + 1), 'image/gif'],
    ] as const) {
      const refused = await upload(rig, session.id, id, bytes, type);
      assert.equal(refused.status, 422, type);
      assert.equal(await errorCode(refused), 'attachment_dimensions_too_large');
    }

    for (const [response, original] of [
      [await declared(rig, session.id, id, ATTACHMENT_LIMITS.modelBytes + 1), false],
      [await upload(rig, session.id, id, chunked(ATTACHMENT_LIMITS.modelBytes)), false],
      [await declared(rig, session.id, id, ATTACHMENT_LIMITS.originalBytes + 1, true), true],
    ] as const) {
      assert.equal(response.status, 413, `original: ${original}`);
      assert.equal(await errorCode(response), 'attachment_too_large');
    }

    assert.equal((await download(rig, session.id, id)).status, 404, 'no refused upload was stored');
    assert.deepEqual(await objectKeys(rig), []);

    // Each file of every type at the edge is taken; the original may be larger than a model copy, and any shape.
    for (const [bytes, type] of [
      [jpeg(modelEdge, modelEdge), 'image/jpeg'],
      [webp(modelEdge, 1), 'image/webp'],
      [gif(1, modelEdge), 'image/gif'],
    ] as const) {
      assert.equal((await upload(rig, session.id, crypto.randomUUID(), bytes, type)).status, 201, type);
    }

    const created = await upload(rig, session.id, id, image);
    assert.equal(created.status, 201);
    const attachment = Attachment.parse(await created.json());
    assert.deepEqual(attachment, { id, mediaType: 'image/png', bytes: image.length });

    const retried = await upload(rig, session.id, id, image);
    assert.equal(retried.status, 200);
    assert.deepEqual(Attachment.parse(await retried.json()), attachment);

    const original = randomBytes(ATTACHMENT_LIMITS.modelBytes + 1000);
    const storedOriginal = await upload(rig, session.id, id, original, 'image/jpeg', true);
    assert.equal(storedOriginal.status, 201);
    assert.deepEqual(Attachment.parse(await storedOriginal.json()), {
      id,
      mediaType: 'image/jpeg',
      bytes: original.length,
    });
    assert.equal((await upload(rig, session.id, id, original, 'image/jpeg', true)).status, 200);

    for (const conflict of [
      await upload(rig, session.id, id, png(800, 600)),
      await upload(rig, session.id, id, jpeg(800, 600), 'image/jpeg'),
      await upload(rig, session.id, id, randomBytes(1000), 'image/jpeg', true),
      await upload(rig, session.id, id, original, 'image/png', true),
    ]) {
      assert.equal(conflict.status, 409);
      assert.equal(await errorCode(conflict), 'operation_conflict');
    }

    // A retry's or a conflict's copy is deleted: one object per file.
    assert.equal((await objectKeys(rig, `${session.id}/${id}/`)).length, 2);

    await assertDownloads(rig, session.id, id, image, 'image/png');
    await assertDownloads(rig, session.id, id, original, 'image/jpeg', true);

    // A chunked original is read whole before it is stored.
    const small = randomBytes(3000);
    const chunkedId = crypto.randomUUID();

    const chunkedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(small);
        controller.close();
      },
    });

    assert.equal((await upload(rig, session.id, chunkedId, chunkedBody, 'image/webp', true)).status, 201);
    await assertDownloads(rig, session.id, chunkedId, small, 'image/webp', true);

    // An original alone doesn't make a model copy.
    const missing = await download(rig, session.id, chunkedId);
    assert.equal(missing.status, 404);
    assert.equal(await errorCode(missing), 'attachment_not_found');
    assert.equal((await download(rig, session.id, crypto.randomUUID(), { headers: auth }, true)).status, 404);

    // Another session's upload is unknown here.
    const other = await rig.create();
    const elsewhere = await download(rig, other.id, id);
    assert.equal(elsewhere.status, 404);
    assert.equal(await errorCode(elsewhere), 'attachment_not_found');
  } finally {
    await rig.close();
  }
});

test(
  'a message with images reaches the model as public bucket addresses, every client sees image blocks, and nothing leaks',
  { timeout: 120_000 },
  async () => {
    const rig = await lifecycleRig();

    try {
      const session = await rig.create();

      const images = [
        { id: crypto.randomUUID(), mediaType: 'image/png', bytes: png(modelEdge, 1200, 1024 * 1024) },
        { id: crypto.randomUUID(), mediaType: 'image/jpeg', bytes: jpeg(1200, modelEdge, 1024 * 1024) },
        { id: crypto.randomUUID(), mediaType: 'image/webp', bytes: webp(2000, 2000, 1024 * 1024) },
        { id: crypto.randomUUID(), mediaType: 'image/gif', bytes: gif(800, 600, 1024 * 1024) },
        { id: crypto.randomUUID(), mediaType: 'image/png', bytes: png(64, 64, 1024 * 1024) },
      ];

      assert.equal(images.length, ATTACHMENT_LIMITS.perMessage);
      const original = randomBytes(2 * 1024 * 1024);
      // A slice of each image's bytes, raw and as base64: no stored row may hold the one, no response the other.
      const raw = images.map(({ bytes }) => bytes.subarray(4096, 4160).toString('latin1'));
      const encoded = images.map(({ bytes }) => bytes.toString('base64').slice(8192, 8256));
      const responses: string[] = [];
      const stream = await rig.events(session.id);

      for (const { id, bytes, mediaType } of images) {
        const response = await upload(rig, session.id, id, bytes, mediaType);
        assert.equal(response.status, 201);
        responses.push(await response.text());
      }

      const storedOriginal = await upload(rig, session.id, images[0]?.id ?? '', original, 'image/jpeg', true);
      assert.equal(storedOriginal.status, 201);

      const unknown = await rig.api(rig.conversation(session.id) + '/messages', {
        operationId: crypto.randomUUID(),
        text: 'look',
        attachments: [crypto.randomUUID()],
      });

      assert.equal(unknown.status, 404);
      assert.equal(await errorCode(unknown), 'attachment_not_found');

      const text = 'What is in these pictures?';
      const ids = images.map(({ id }) => id);

      const sent = await rig.api(rig.conversation(session.id) + '/messages', {
        operationId: crypto.randomUUID(),
        text,
        attachments: ids,
      });

      responses.push(await sent.clone().text());
      await rig.accepted(sent);
      await rig.settled(session.id);

      // The model got the text, then a URL per image in order, and no image bytes.
      const firstBody = rig.bodies[0] ?? '';

      const [first] = ModelRequest.parse(JSON.parse(firstBody)).messages.flatMap(({ content }) => {
        const parsed = ImageMessage.safeParse(content);

        return parsed.success ? [parsed.data] : [];
      });

      assert.ok(first, 'one message of the model request carries the images');
      assert.equal(first[0].text, text);
      assert.equal(firstBody.includes('"base64"'), false);
      const urls = first.slice(1).map((block) => new URL(UrlImage.parse(block).source.url));

      for (const [index, url] of urls.entries()) {
        const image = images[index];

        assert.equal(url.origin, PUBLIC_BASE);
        assert.match(url.pathname, new RegExp(`^/${session.id}/${image?.id}/model/[0-9a-f-]{36}$`));

        // What the model fetches: the model copy at that key, never the original.
        const object = await (await rig.attachments()).get(url.pathname.slice(1));
        assert.equal(object?.httpMetadata?.contentType, image?.mediaType);
        assert.ok(
          Buffer.from((await object?.arrayBuffer()) ?? new ArrayBuffer(0)).equals(image?.bytes ?? Buffer.alloc(0)),
        );
      }

      const blocks = [
        { kind: 'text', text },
        ...images.map(({ id, mediaType }) => ({ kind: 'image', attachmentId: id, mediaType })),
      ];

      const userMessage = (entries: readonly Entry[]) =>
        entries.find((entry) => entry.kind === 'message' && entry.role === 'user');

      const withImages = (snapshot: Snapshot) => {
        const user = userMessage(snapshot.history.entries);

        return user?.kind === 'message' && user.content.length === blocks.length;
      };

      const streamed = await stream.until(withImages);

      const userOf = (entries: readonly Entry[]) => {
        const user = userMessage(entries);

        return user?.kind === 'message' ? user.content : undefined;
      };

      assert.deepEqual(userOf(streamed.history.entries), blocks);

      const snapshotResponse = await rig.api(rig.conversation(session.id) + '/snapshot');
      const snapshotText = await snapshotResponse.text();
      assert.deepEqual(userOf(Snapshot.parse(JSON.parse(snapshotText)).history.entries), blocks);

      const historyResponse = await rig.api(rig.conversation(session.id) + '/history?limit=100');
      const historyText = await historyResponse.text();
      const history = HistoryResponse.parse(JSON.parse(historyText));
      assert.deepEqual(userOf(history.entries), blocks);
      assert.ok(userMessage(history.entries)?.native, 'history still carries the native record');

      for (const { id, bytes, mediaType } of images) await assertDownloads(rig, session.id, id, bytes, mediaType);
      await assertDownloads(rig, session.id, ids[0] ?? '', original, 'image/jpeg', true);

      // Going back to just after the message keeps the same images, which download by the same IDs.
      const user = history.entries.findIndex((entry) => entry === userMessage(history.entries));
      const answer = history.entries[user + 1];
      assert.ok(user >= 0 && answer);
      const fork = (await rig.rewind(session.id, answer.id)).conversationId;
      assert.deepEqual(userOf((await rig.snapshot(session.id, fork)).history.entries), blocks);

      // Sending an image again, and every later request, carries the same URLs, so the prompt cache keeps matching.
      const again = await rig.api(rig.conversation(session.id, fork) + '/messages', {
        operationId: crypto.randomUUID(),
        text: 'And this one again?',
        attachments: [ids[2] ?? ''],
      });

      responses.push(await again.clone().text());
      await rig.accepted(again);
      await rig.settled(session.id);
      const lastBody = rig.bodies.at(-1) ?? '';

      for (const url of urls) assert.ok(lastBody.includes(url.href), `the later request names ${url.href}`);
      assert.equal(lastBody.split(urls[2]?.href ?? 'missing').length - 1, 2, 'the image sent again has the same URL');

      responses.push(
        snapshotText,
        historyText,
        await (await rig.api(rig.conversation(session.id) + '/snapshot')).text(),
        await (await rig.api(rig.conversation(session.id) + '/history?limit=100')).text(),
        await (await rig.api(`/v1/sessions/${session.id}`)).text(),
        await (await rig.api('/v1/sessions')).text(),
        JSON.stringify(stream.received.map(({ event }) => event)),
      );

      const stored = await storedText(rig.storage);

      // The key's random part is what keeps a file private: no response or event names it, nor the bucket's address.
      for (const secret of [PUBLIC_BASE, ...urls.map((url) => url.pathname.split('/').at(-1) ?? 'missing')]) {
        assert.equal(
          responses.some((body) => body.includes(secret)),
          false,
          'no response or event carries a bucket address',
        );
      }

      assert.equal(stored.includes(PUBLIC_BASE), false, 'no stored row holds a URL');

      for (const marker of encoded)
        assert.equal(
          responses.some((body) => body.includes(marker)),
          false,
        );

      for (const marker of raw) assert.equal(stored.includes(marker), false, 'the Thread stores no image bytes');

      await stream.close();
    } finally {
      await rig.close();
    }
  },
);

test(
  'queued and cancelled messages keep their images, named images are never evicted, and unsent uploads are bounded',
  { timeout: 120_000 },
  async () => {
    const rig = await lifecycleRig();
    const calls: Array<() => void> = [];

    rig.setAnswer(
      (_body, request) =>
        new Promise<WorkerResponse>((resolve) => {
          const finish = () => resolve(modelAnswer(model.id));
          calls.push(finish);
          request.signal.addEventListener('abort', finish, { once: true });
        }),
    );

    try {
      const session = await rig.create();
      const images = [crypto.randomUUID(), crypto.randomUUID()];
      const bytes = images.map(() => png(100, 100));

      for (const [index, id] of images.entries()) {
        assert.equal((await upload(rig, session.id, id, bytes[index] ?? new Uint8Array())).status, 201);
      }

      const messages = rig.conversation(session.id) + '/messages';
      await rig.accepted(await rig.api(messages, { operationId: crypto.randomUUID(), text: 'first' }));
      await waitFor(() => calls[0]);

      const queued = await rig.accepted(
        await rig.api(messages, {
          operationId: crypto.randomUUID(),
          text: 'later',
          mode: 'followUp',
          attachments: images,
        }),
      );

      const pending = (await rig.session(session.id)).pending;
      assert.deepEqual(pending.find(({ operationId }) => operationId === queued.operationId)?.attachments, images);

      // Cancelling the queued message hands its draft back with its images, which are still there to send again.
      const cancelled = await rig.api(rig.conversation(session.id) + '/cancel', {
        operationId: crypto.randomUUID(),
        runId: queued.runId,
      });

      assert.equal(cancelled.status, 202, await cancelled.clone().text());
      assert.deepEqual(CancelRunResponse.parse(await cancelled.json()).restoredMessages, [
        { operationId: queued.operationId, mode: 'followUp', text: 'later', attachments: images },
      ]);

      calls[0]?.();
      await rig.settled(session.id);

      // Past the bound, each new upload removes the oldest unsent one with its files; named ones stay.
      const later = Array.from({ length: UNSENT_UPLOAD_LIMIT + 1 }, () => crypto.randomUUID());

      for (const id of later) assert.equal((await upload(rig, session.id, id, png(10, 10))).status, 201);

      const [oldest, kept] = later;
      assert.equal((await download(rig, session.id, oldest ?? '')).status, 404);
      assert.deepEqual(await objectKeys(rig, `${session.id}/${oldest}/`), []);
      assert.equal((await download(rig, session.id, kept ?? '')).status, 200);

      for (const [index, id] of images.entries()) {
        await assertDownloads(rig, session.id, id, bytes[index] ?? new Uint8Array(), 'image/png');
      }

      const resend = await rig.api(messages, {
        operationId: crypto.randomUUID(),
        text: 'later',
        attachments: [oldest ?? ''],
      });

      assert.equal(resend.status, 404);
      assert.equal(await errorCode(resend), 'attachment_not_found');

      // The cancelled draft's images send again as they are.
      await rig.accepted(
        await rig.api(messages, { operationId: crypto.randomUUID(), text: 'later', attachments: images }),
      );
      await waitFor(() => calls[1]);
      calls[1]?.();
      await rig.settled(session.id);
    } finally {
      await rig.close();
    }
  },
);
