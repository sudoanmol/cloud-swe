import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";

export interface AttachmentObjectStore {
  put(input: {
    key: string;
    body: Readable | Uint8Array;
    size: number;
    contentType: string;
    sha256: string;
  }): Promise<void>;
  get(key: string): Promise<AsyncIterable<Uint8Array>>;
  delete(keys: readonly string[]): Promise<void>;
}

export class AttachmentObjectNotFoundError extends Error {
  constructor() {
    super("Attachment object not found");
    this.name = "AttachmentObjectNotFoundError";
  }
}

// oxlint-disable-next-line anti-slop/no-object-parameters -- AWS owns this body union; this guard selects its async byte-stream member.
function isByteStream(value: object): value is AsyncIterable<Uint8Array> {
  return Symbol.asyncIterator in value;
}

export function createAttachmentObjectStore(config: {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
}): AttachmentObjectStore {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    async put({ key, body, size, contentType, sha256 }) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentLength: size,
          ContentType: contentType,
          Metadata: { sha256 },
          IfNoneMatch: "*",
        }),
      );
    },

    async get(key) {
      let body;

      try {
        body = (await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))).Body;
      } catch (error) {
        if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404)
          throw new AttachmentObjectNotFoundError();
        throw error;
      }

      if (!body || !isByteStream(body)) throw new Error("Attachment object has no readable body");

      return body;
    },

    async delete(keys) {
      await Promise.all(
        keys.map((key) =>
          client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key })),
        ),
      );
    },
  };
}
