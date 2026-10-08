import { createHash } from "node:crypto";
import { z } from "zod";
import {
  decodePiSessionCheckpoint,
  type PiAttachmentImageReference,
  type PiSessionCheckpoint,
} from "@cloud-swe/db/checkpoint";
import type { FileEntry } from "@earendil-works/pi-coding-agent";

/**
 * Metadata for the resumable `pi-session` checkpoint. The reliability fields
 * are optional for decoding pre-contract checkpoints; newly produced metadata
 * always includes them.
 */
export interface PiSessionMetadata {
  sessionId: string;
  provider: string;
  model: string;
  entries: FileEntry[];
  runId?: string;
  attemptId?: string;
  workspaceGeneration?: number;
  assistantAttempt?: number;
}

export type PiPersistedSessionMetadata = Omit<PiSessionMetadata, "entries"> & {
  version: 2;
  entries: Extract<PiSessionCheckpoint, { version: 2 }>["entries"];
};

export class PiCheckpointLimitError extends Error {
  readonly sizeBytes: number;
  readonly limitBytes: number;

  constructor(sizeBytes: number, limitBytes: number) {
    super(`Pi session checkpoint is ${sizeBytes} bytes; configured limit is ${limitBytes} bytes`);
    this.name = "PiCheckpointLimitError";
    this.sizeBytes = sizeBytes;
    this.limitBytes = limitBytes;
  }
}

export class PiCheckpointSerializationError extends Error {
  constructor() {
    super("Pi session checkpoint is not JSON serializable");
    this.name = "PiCheckpointSerializationError";
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Validate persisted checkpoint metadata at the read boundary.
export function parsePiSessionMetadata(value: unknown): PiSessionCheckpoint | undefined {
  try {
    return decodePiSessionCheckpoint(value);
  } catch {
    return undefined;
  }
}

export function serializedPiCheckpointBytes(
  metadata: PiSessionMetadata | PiPersistedSessionMetadata,
): number {
  try {
    const payload = {
      kind: "pi",
      ...metadata,
      version: "version" in metadata ? metadata.version : 2,
    };

    return Buffer.byteLength(JSON.stringify(payload), "utf8");
  } catch {
    throw new PiCheckpointSerializationError();
  }
}

function checkpointImageKey(input: {
  data?: string;
  sha256?: string;
  mimeType: string;
  size?: number;
}) {
  if (input.data !== undefined) {
    const data = Buffer.from(input.data, "base64");

    return `${createHash("sha256").update(data).digest("hex")}:${input.mimeType}:${data.byteLength}`;
  }

  return `${input.sha256}:${input.mimeType}:${input.size}`;
}

export function referenceCheckpointImages(
  metadata: PiSessionMetadata,
  references: PiAttachmentImageReference[],
): PiPersistedSessionMetadata {
  const queues = new Map<string, PiAttachmentImageReference[]>();

  for (const reference of references) {
    const key = checkpointImageKey(reference);
    queues.set(key, [...(queues.get(key) ?? []), reference]);
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Recursively rewrite validated Pi entry JSON, then validate the complete checkpoint below.
  const replace = (value: unknown): unknown => {
    const image = z
      .object({ type: z.literal("image"), data: z.string(), mimeType: z.string() })
      .safeParse(value);

    if (image.success) return queues.get(checkpointImageKey(image.data))?.shift() ?? value;

    if (Array.isArray(value)) return value.map(replace);

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Establish the JSON object branch before enumerating its validated children.
    if (typeof value !== "object" || value === null) return value;

    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]));
  };

  const checkpoint = decodePiSessionCheckpoint({
    ...metadata,
    version: 2,
    entries: metadata.entries.map(replace),
  });

  if (checkpoint.version !== 2) throw new PiCheckpointSerializationError();

  return checkpoint;
}

export function assertPiCheckpointSize(
  metadata: PiSessionMetadata | PiPersistedSessionMetadata,
  limitBytes: number,
): void {
  const sizeBytes = serializedPiCheckpointBytes(metadata);

  if (sizeBytes > limitBytes) throw new PiCheckpointLimitError(sizeBytes, limitBytes);
}
