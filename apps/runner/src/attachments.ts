import {
  AttachmentObjectNotFoundError,
  type AttachmentObjectStore,
} from "@cloud-swe/db/attachment-objects";
import {
  decodeLivePiSessionEntries,
  piAttachmentImageReferenceSchema,
  type PiAttachmentImageReference,
  type PiSessionCheckpoint,
} from "@cloud-swe/db/checkpoint";
import { ThreadStoreError, type AttachmentRecord } from "@cloud-swe/db/thread-contracts";
import { safeAttachmentFilename } from "@cloud-swe/db/threads";
import { createHash } from "node:crypto";
import { quoteShell } from "./text.js";
import type { CommandRequest, CommandResult } from "./sandbox.js";

const chunkBytes = 128 * 1024;

type Execute = (request: CommandRequest) => Promise<CommandResult>;

function checked(result: CommandResult): string {
  if (result.kind === "completed" && result.statusCode === 65)
    throw new ThreadStoreError("ATTACHMENT_INVALID", "The workspace attachment path is unsafe");

  if (result.kind !== "completed" || result.statusCode !== 0 || result.outputTruncated)
    throw new ThreadStoreError(
      "ATTACHMENT_MATERIALIZATION_FAILED",
      "Could not restore an attachment into the workspace",
    );

  return result.stdout.trim();
}

async function attachmentBody(objects: AttachmentObjectStore, key: string) {
  try {
    return await objects.get(key);
  } catch (error) {
    if (error instanceof AttachmentObjectNotFoundError)
      throw new ThreadStoreError("ATTACHMENT_OBJECT_INVALID", "Stored attachment is missing", 422);
    throw error;
  }
}

function targetPath(item: AttachmentRecord): string {
  return `/workspace/.attachments/${item.id}/${safeAttachmentFilename(item.filename)}`;
}

const prepareProgram = `
import hashlib, os, pathlib, sys
root=pathlib.Path('/workspace/.attachments')
attachment_id,name,size,digest=sys.argv[1:]
if root.is_symlink(): raise SystemExit(65)
if root.exists() and not root.is_dir(): raise SystemExit(65)
root.mkdir(mode=0o700,parents=True,exist_ok=True)
ignore=root/'.gitignore'
if ignore.is_symlink(): raise SystemExit(65)
if ignore.exists() and not ignore.is_file(): raise SystemExit(65)
if not ignore.exists(): ignore.write_text('*\\n',encoding='utf-8')
directory=root/attachment_id
if directory.is_symlink(): raise SystemExit(65)
if directory.exists() and not directory.is_dir(): raise SystemExit(65)
directory.mkdir(mode=0o700,exist_ok=True)
target=directory/name
if target.is_symlink() or (target.exists() and not target.is_file()): raise SystemExit(65)
if target.is_file() and target.stat().st_size==int(size):
 h=hashlib.sha256()
 with target.open('rb') as f:
  for chunk in iter(lambda:f.read(131072),b''): h.update(chunk)
 if h.hexdigest()==digest:
  print('existing')
  raise SystemExit(0)
temporary=directory/('.upload-'+digest+'.tmp')
if temporary.is_symlink() or (temporary.exists() and not temporary.is_file()): raise SystemExit(65)
with temporary.open('wb'): pass
os.chmod(temporary,0o600)
print('upload')
`;

const chunkProgram = `
import base64, os, pathlib, stat, sys
path=pathlib.Path(sys.argv[1])
offset=int(sys.argv[2])
if path.is_symlink() or not path.is_file() or path.stat().st_size!=offset: raise SystemExit(65)
data=base64.b64decode(sys.stdin.buffer.read(),validate=True)
if len(data)>131072: raise SystemExit(65)
flags=os.O_WRONLY | getattr(os,'O_NOFOLLOW',0)
fd=os.open(path,flags)
try:
 if not stat.S_ISREG(os.fstat(fd).st_mode): raise SystemExit(65)
 written=os.pwrite(fd,data,offset)
 if written!=len(data): raise SystemExit(74)
finally: os.close(fd)
`;

const finishProgram = `
import hashlib, os, pathlib, sys
temporary,target,size,digest=map(str,sys.argv[1:])
source=pathlib.Path(temporary); destination=pathlib.Path(target)
if source.is_symlink() or not source.is_file() or destination.is_symlink(): raise SystemExit(65)
if source.stat().st_size!=int(size): raise SystemExit(65)
h=hashlib.sha256()
with source.open('rb') as f:
 for chunk in iter(lambda:f.read(131072),b''): h.update(chunk)
if h.hexdigest()!=digest: raise SystemExit(65)
os.replace(source,destination)
os.chmod(destination,0o600)
`;

async function materializeOne(
  item: AttachmentRecord,
  objects: AttachmentObjectStore,
  execute: Execute,
): Promise<void> {
  if (!item.originalObjectKey || !item.originalSha256 || item.originalSize === null)
    throw new ThreadStoreError("ATTACHMENT_INVALID", "Attachment metadata is incomplete", 422);
  const target = targetPath(item);
  const temporary = `/workspace/.attachments/${item.id}/.upload-${item.originalSha256}.tmp`;

  const state = checked(
    await execute({
      command: `python3 -c ${quoteShell(prepareProgram)} ${quoteShell(item.id)} ${quoteShell(safeAttachmentFilename(item.filename))} ${item.originalSize} ${item.originalSha256}`,
    }),
  );

  if (state === "existing") return;

  if (state !== "upload")
    throw new ThreadStoreError("ATTACHMENT_MATERIALIZATION_FAILED", "Invalid workspace response");
  const source = await attachmentBody(objects, item.originalObjectKey);
  const hash = createHash("sha256");
  let buffered = Buffer.alloc(0);
  let offset = 0;

  const write = async (data: Buffer) => {
    checked(
      await execute({
        command: `python3 -c ${quoteShell(chunkProgram)} ${quoteShell(temporary)} ${offset}`,
        stdin: data.toString("base64"),
      }),
    );
    hash.update(data);
    offset += data.byteLength;
  };

  for await (const part of source) {
    buffered = Buffer.concat([buffered, Buffer.from(part)]);

    if (offset + buffered.byteLength > item.originalSize)
      throw new ThreadStoreError(
        "ATTACHMENT_OBJECT_INVALID",
        "Stored attachment exceeds its recorded size",
        422,
      );

    while (buffered.byteLength >= chunkBytes) {
      await write(buffered.subarray(0, chunkBytes));
      buffered = buffered.subarray(chunkBytes);
    }
  }

  if (buffered.byteLength) await write(buffered);

  if (offset !== item.originalSize || hash.digest("hex") !== item.originalSha256)
    throw new ThreadStoreError(
      "ATTACHMENT_OBJECT_INVALID",
      "Stored attachment is missing or corrupt",
      422,
    );
  checked(
    await execute({
      command: `python3 -c ${quoteShell(finishProgram)} ${quoteShell(temporary)} ${quoteShell(target)} ${item.originalSize} ${item.originalSha256}`,
    }),
  );
}

export async function materializeAttachments(
  attachments: AttachmentRecord[],
  objects: AttachmentObjectStore,
  execute: Execute,
): Promise<void> {
  for (const item of attachments) await materializeOne(item, objects, execute);
}

async function readModelImage(item: AttachmentRecord, objects: AttachmentObjectStore) {
  if (!item.modelObjectKey || !item.modelSha256 || !item.modelMimeType || item.modelSize === null)
    throw new ThreadStoreError(
      "ATTACHMENT_INVALID",
      "Image attachment metadata is incomplete",
      422,
    );
  const parts: Buffer[] = [];
  let size = 0;
  const hash = createHash("sha256");

  for await (const part of await attachmentBody(objects, item.modelObjectKey)) {
    const bytes = Buffer.from(part);
    size += bytes.byteLength;

    if (size > 3 * 1024 * 1024)
      throw new ThreadStoreError("ATTACHMENT_OBJECT_INVALID", "Stored image exceeds 3 MiB", 422);
    hash.update(bytes);
    parts.push(bytes);
  }

  if (size !== item.modelSize || hash.digest("hex") !== item.modelSha256)
    throw new ThreadStoreError("ATTACHMENT_OBJECT_INVALID", "Stored image is corrupt", 422);

  return Buffer.concat(parts);
}

export async function hydrateCheckpointEntries(input: {
  checkpoint: PiSessionCheckpoint;
  attachments: AttachmentRecord[];
  objects: AttachmentObjectStore;
  userId: string;
}) {
  const byId = new Map(input.attachments.map((item) => [item.id, item]));
  const cache = new Map<string, Buffer>();

  // oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Recursively hydrate validated checkpoint JSON, then validate the complete live entries below.
  const replace = async (value: unknown): Promise<unknown> => {
    const reference = piAttachmentImageReferenceSchema.safeParse(value);

    if (reference.success) {
      const item = byId.get(reference.data.attachmentId);

      if (
        !item ||
        item.userId !== input.userId ||
        item.classification !== "image" ||
        item.modelSha256 !== reference.data.sha256 ||
        item.modelMimeType !== reference.data.mimeType ||
        item.modelSize !== reference.data.size
      )
        throw new ThreadStoreError(
          "ATTACHMENT_REFERENCE_INVALID",
          "Saved image reference is stale or belongs to another thread",
          422,
        );
      let data = cache.get(item.id);

      if (!data) {
        data = await readModelImage(item, input.objects);
        cache.set(item.id, data);
      }

      return { type: "image", data: data.toString("base64"), mimeType: item.modelMimeType };
    }

    if (Array.isArray(value)) return Promise.all(value.map(replace));

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Establish the JSON object branch before enumerating its validated children.
    if (typeof value !== "object" || value === null) return value;

    return Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async ([key, child]) => [key, await replace(child)]),
      ),
    );
  };

  return decodeLivePiSessionEntries(await Promise.all(input.checkpoint.entries.map(replace)));
}

export async function promptImages(
  attachments: AttachmentRecord[],
  objects: AttachmentObjectStore,
): Promise<Array<{ type: "image"; data: string; mimeType: string }>> {
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];

  for (const item of attachments) {
    if (item.classification !== "image") continue;
    const data = await readModelImage(item, objects);
    const mimeType = item.modelMimeType;

    if (!mimeType)
      throw new ThreadStoreError("ATTACHMENT_INVALID", "Image MIME type is missing", 422);
    images.push({ type: "image", data: data.toString("base64"), mimeType });
  }

  return images;
}

export function attachmentImageReferences(
  attachments: AttachmentRecord[],
): PiAttachmentImageReference[] {
  return attachments.flatMap((item) => {
    if (item.classification !== "image") return [];

    return [
      piAttachmentImageReferenceSchema.parse({
        type: "attachment_image",
        attachmentId: item.id,
        variant: "model",
        sha256: item.modelSha256,
        mimeType: item.modelMimeType,
        size: item.modelSize,
      }),
    ];
  });
}

export function checkpointAttachmentIds(checkpoint: PiSessionCheckpoint): Set<string> {
  const ids = new Set<string>();

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Recursively inspect checkpoint JSON through the attachment-reference schema.
  const visit = (value: unknown): void => {
    const reference = piAttachmentImageReferenceSchema.safeParse(value);

    if (reference.success) {
      ids.add(reference.data.attachmentId);

      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) visit(item);

      return;
    }

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Establish the JSON object branch before enumerating its validated children.
    if (typeof value !== "object" || value === null) return;

    for (const child of Object.values(value)) visit(child);
  };

  visit(checkpoint.entries);

  return ids;
}

export function attachmentManifest(attachments: AttachmentRecord[]): string {
  if (!attachments.length) return "";

  return `Attachments:\n${JSON.stringify(
    attachments.map((item) => ({
      id: item.id,
      filename: item.filename,
      path: targetPath(item),
      mimeType: item.detectedMimeType,
      size: item.originalSize,
      classification: item.classification,
    })),
  )}\n\n`;
}
