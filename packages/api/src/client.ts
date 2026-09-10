import { z } from "zod";

export class ThreadApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ThreadApiError";
    this.status = status;
    this.code = code;
  }
}

export type ThreadClientOptions = {
  baseUrl: string;
  credentials?: "omit" | "same-origin" | "include";
  headers?: Record<string, string | readonly string[]> | Array<Array<string>>;
};

export type CreateThreadInput = {
  prompt: string;
  clientMessageId: string;
  repositoryUrl?: string;
  branch?: string;
};

export type FollowupInput = {
  threadId: string;
  prompt: string;
  clientMessageId: string;
};

export type CancelRunInput = {
  threadId: string;
  runId: string;
};

const errorPayloadSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }),
});

const submitResultSchema = z.object({
  threadId: z.uuid(),
  runId: z.uuid(),
});

const cancelResultSchema = z.object({
  runId: z.uuid(),
  cancelRequested: z.literal(true),
});

const isoDateSchema = z.string().min(1);

const threadSnapshotSchema = z.object({
  id: z.uuid(),
  userId: z.string().min(1),
  title: z.string().nullable(),
  repositoryUrl: z.string().nullable(),
  repositoryBranch: z.string().nullable(),
  messages: z.array(
    z.object({
      id: z.string().min(1),
      role: z.string().min(1),
      content: z.string(),
      clientMessageId: z.string().nullable(),
      createdAt: isoDateSchema,
    }),
  ),
  runs: z.array(
    z.object({
      id: z.uuid(),
      status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
      prompt: z.string(),
      cancelRequestedAt: isoDateSchema.nullable(),
      createdAt: isoDateSchema,
      completedAt: isoDateSchema.nullable(),
      error: z.string().nullable(),
    }),
  ),
  workspace: z
    .object({
      id: z.uuid(),
      state: z.string().min(1),
      provider: z.string().min(1),
      generation: z.number().int().positive(),
    })
    .nullable(),
  latestEventId: z.number().int().nonnegative().nullable(),
});

export type SubmitResult = z.infer<typeof submitResultSchema>;
export type CancelResult = z.infer<typeof cancelResultSchema>;
export type ThreadSnapshot = z.infer<typeof threadSnapshotSchema>;

export type ThreadStreamEvent = {
  sequence: number;
  type: string;
  payload: unknown;
};

const runStatusByEvent = {
  "run.queued": "queued",
  "run.started": "running",
  "run.completed": "completed",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
} as const;

function readRunId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  if (!("runId" in payload) || typeof payload.runId !== "string") return null;
  return payload.runId;
}

function isRunLifecycleType(type: string): type is keyof typeof runStatusByEvent {
  return Object.hasOwn(runStatusByEvent, type);
}

export function applyRunLifecycleEvent(
  snapshot: ThreadSnapshot,
  event: ThreadStreamEvent,
): ThreadSnapshot {
  if (!isRunLifecycleType(event.type)) return snapshot;
  const status = runStatusByEvent[event.type];
  const runId = readRunId(event.payload);
  if (!runId) return snapshot;
  let changed = false;
  const runs = snapshot.runs.map((run) => {
    if (run.id !== runId) return run;
    changed = true;
    return { ...run, status };
  });
  return changed ? { ...snapshot, runs } : snapshot;
}

export type StreamEventsInput = {
  threadId: string;
  after?: number;
  signal?: AbortSignal;
  onEvent: (event: ThreadStreamEvent) => void;
};

export type ThreadClient = {
  healthCheck(): Promise<string>;
  createThread(input: CreateThreadInput): Promise<SubmitResult>;
  submitMessage(input: FollowupInput): Promise<SubmitResult>;
  getThread(threadId: string): Promise<ThreadSnapshot>;
  cancelRun(input: CancelRunInput): Promise<CancelResult>;
  streamEvents(input: StreamEventsInput): Promise<void>;
};

function joinUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

type ClientHeaders = Record<string, string | readonly string[]> | Array<Array<string>> | Headers;

function mergeHeaders(...parts: Array<ClientHeaders | undefined>): Headers {
  const headers = new Headers();
  for (const part of parts) {
    if (!part) continue;
    if (part instanceof Headers) {
      part.forEach((value, key) => headers.set(key, value));
    } else if (Array.isArray(part)) {
      for (const pair of part) {
        const key = pair[0];
        const value = pair[1];
        if (key !== undefined && value !== undefined) headers.set(key, value);
      }
    } else {
      for (const [key, value] of Object.entries(part)) {
        headers.set(key, typeof value === "string" ? value : value.join(", "));
      }
    }
  }
  return headers;
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function readErrorPayload(value: unknown): { code: string; message: string } | null {
  const parsed = errorPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data.error : null;
}

function parseChecked<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ThreadApiError(500, "INVALID_RESPONSE", "Unexpected API response");
  }
  return parsed.data;
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return parseJson(text);
  } catch {
    return text;
  }
}

async function throwIfError(response: Response, body: unknown): Promise<void> {
  if (response.ok) return;
  const error = readErrorPayload(body);
  throw new ThreadApiError(
    response.status,
    error?.code ?? "REQUEST_FAILED",
    error?.message ?? `Request failed with status ${response.status}`,
  );
}

function parseSseFrame(part: string): ThreadStreamEvent | null {
  let id: string | undefined;
  let type: string | undefined;
  const dataLines: string[] = [];
  for (const line of part.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) continue;
    if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (!id || !type) return null;
  const sequence = Number(id);
  if (!Number.isInteger(sequence) || sequence < 0) return null;
  const data = dataLines.join("\n");
  let payload: unknown = null;
  if (data.length > 0) {
    try {
      payload = parseJson(data);
    } catch {
      payload = data;
    }
  }
  return { sequence, type, payload };
}

export function consumeSse(buffer: string): { events: ThreadStreamEvent[]; rest: string } {
  let held = "";
  let work = buffer;
  if (work.endsWith("\r")) {
    held = "\r";
    work = work.slice(0, -1);
  }
  work = work.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const parts = work.split("\n\n");
  const rest = `${parts.pop() ?? ""}${held}`;
  const events: ThreadStreamEvent[] = [];
  for (const part of parts) {
    const event = parseSseFrame(part);
    if (event) events.push(event);
  }
  return { events, rest };
}

export function createThreadClient(options: ThreadClientOptions): ThreadClient {
  const credentials = options.credentials ?? "include";

  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers = mergeHeaders(options.headers, init.headers);
    const response = await fetch(joinUrl(options.baseUrl, path), {
      ...init,
      headers,
      credentials,
    });
    const body = await parseBody(response);
    await throwIfError(response, body);
    return body;
  }

  async function mutate(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers: Record<string, string> = {
      "x-csrf-protection": "1",
    };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    return request(path, {
      ...init,
      method: init.method ?? "POST",
      headers: mergeHeaders(headers, init.headers),
    });
  }

  return {
    async healthCheck() {
      const body = await request("/");
      return parseChecked(z.string(), body);
    },

    async createThread(input) {
      const body = await mutate("/api/threads", {
        body: JSON.stringify({
          prompt: input.prompt,
          clientMessageId: input.clientMessageId,
          ...(input.repositoryUrl ? { repositoryUrl: input.repositoryUrl } : {}),
          ...(input.branch ? { branch: input.branch } : {}),
        }),
      });
      return parseChecked(submitResultSchema, body);
    },

    async submitMessage(input) {
      const body = await mutate(`/api/threads/${input.threadId}/messages`, {
        body: JSON.stringify({
          prompt: input.prompt,
          clientMessageId: input.clientMessageId,
        }),
      });
      return parseChecked(submitResultSchema, body);
    },

    async getThread(threadId) {
      return parseChecked(threadSnapshotSchema, await request(`/api/threads/${threadId}`));
    },

    async cancelRun(input) {
      return parseChecked(
        cancelResultSchema,
        await mutate(`/api/threads/${input.threadId}/runs/${input.runId}/cancel`),
      );
    },

    async streamEvents(input) {
      const after = input.after ?? 0;
      const url = new URL(joinUrl(options.baseUrl, `/api/threads/${input.threadId}/events`));
      url.searchParams.set("after", String(after));
      const headers = mergeHeaders(options.headers, {
        accept: "text/event-stream",
        "last-event-id": String(after),
      });
      const response = await fetch(url, {
        headers,
        credentials,
        signal: input.signal,
      });
      if (!response.ok) {
        const body = await parseBody(response);
        await throwIfError(response, body);
      }
      if (!response.body)
        throw new ThreadApiError(500, "INVALID_RESPONSE", "Event stream was empty");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const consumed = consumeSse(buffer);
          buffer = consumed.rest;
          for (const event of consumed.events) input.onEvent(event);
        }
        buffer += decoder.decode();
        const consumed = consumeSse(
          buffer.endsWith("\n\n") || buffer.endsWith("\r\n\r\n") ? buffer : `${buffer}\n\n`,
        );
        for (const event of consumed.events) input.onEvent(event);
      } finally {
        reader.releaseLock();
      }
    },
  };
}
