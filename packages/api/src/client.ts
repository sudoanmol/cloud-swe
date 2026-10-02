import { z } from "zod";
import { jsonValueSchema, type JsonValue } from "@cloud-swe/db/json";

import {
  cancelResultSchema,
  errorPayloadSchema,
  submitResultSchema,
  threadSnapshotSchema,
  type CancelResult,
  type SubmitResult,
  type ThreadSnapshot,
} from "./contracts";

export class ThreadApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Parsed `Retry-After` in milliseconds when the server supplied one. */
  readonly retryAfterMs: number | null;

  constructor(status: number, code: string, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = "ThreadApiError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export type ApiTransportOptions = {
  baseUrl: string;
  credentials?: "omit" | "same-origin" | "include";
  headers?: Record<string, string | readonly string[]> | Array<Array<string>>;
};

export type ThreadStreamEvent = {
  sequence: number;
  type: string;
  payload: JsonValue;
};

export type StreamEventsInput = {
  threadId: string;
  after?: number;
  signal?: AbortSignal;
  onEvent: (event: ThreadStreamEvent) => void;
  onOpen?: () => void;
  /** Validates known payloads; unknown future event names pass through. */
  validate?: (event: ThreadStreamEvent) => void;
};

type ClientHeaders = Record<string, string | readonly string[]> | Array<Array<string>> | Headers;

function joinUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

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
        headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
      }
    }
  }

  return headers;
}

function parseJson(text: string): JsonValue {
  return jsonValueSchema.parse(JSON.parse(text));
}

function readErrorPayload(value: JsonValue): { code: string; message: string } | null {
  const parsed = errorPayloadSchema.safeParse(value);

  return parsed.success ? parsed.data.error : null;
}

export function parseChecked<T>(schema: z.ZodType<T>, body: JsonValue): T {
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    throw new ThreadApiError(500, "INVALID_RESPONSE", "Unexpected API response");
  }

  return parsed.data;
}

async function parseBody(response: Response): Promise<JsonValue> {
  const text = await response.text();

  if (text.length === 0) return null;

  try {
    return parseJson(text);
  } catch {
    return text;
  }
}

async function throwIfError(response: Response, body: JsonValue): Promise<void> {
  if (response.ok) return;
  const error = readErrorPayload(body);
  const retryAfter = response.headers.get("retry-after");
  const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1_000 : null;

  throw new ThreadApiError(
    response.status,
    error?.code ?? "REQUEST_FAILED",
    error?.message ?? `Request failed with status ${response.status}`,
    retryAfterMs,
  );
}

type ResponseExpectation = "json" | "text" | "event-stream";

function responseContentType(response: Response): string {
  return response.headers.get("content-type")?.toLowerCase() ?? "";
}

function assertContentType(response: Response, expectation: ResponseExpectation): void {
  const contentType = responseContentType(response);

  if (expectation === "json" && !contentType.includes("application/json"))
    throw new ThreadApiError(500, "INVALID_RESPONSE", "Expected a JSON response");

  if (expectation === "event-stream" && !contentType.includes("text/event-stream"))
    throw new ThreadApiError(500, "INVALID_RESPONSE", "Expected an event stream");
}

/** Bound the retained framing buffer so a peer cannot grow it without limit. */
export const SSE_MAX_BUFFER_BYTES = 1024 * 1024;

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
  let payload: JsonValue = null;

  if (data.length > 0) {
    try {
      payload = parseJson(data);
    } catch {
      payload = data;
    }
  }

  return { sequence, type, payload };
}

/**
 * Incremental SSE decoder. Split UTF-8 is handled by the caller's
 * `TextDecoder({ stream: true })`; this retains CRLF framing across chunks and
 * ignores heartbeat comments.
 */
export function consumeSse(buffer: string) {
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

/**
 * Small browser-safe HTTP/SSE transport. Endpoint-specific fetching lives in
 * React Query options and mutations, not in an endpoint facade.
 */
export function createApiTransport(options: ApiTransportOptions) {
  const credentials = options.credentials ?? "include";

  async function request(
    path: string,
    init: RequestInit = {},
    baseHeaders?: ClientHeaders,
    expectation: ResponseExpectation | undefined = undefined,
  ): Promise<JsonValue> {
    const headers = mergeHeaders(options.headers, baseHeaders, init.headers);

    const response = await fetch(joinUrl(options.baseUrl, path), {
      ...init,
      headers,
      credentials,
    });

    if (expectation) assertContentType(response, expectation);

    const body = await parseBody(response);
    await throwIfError(response, body);

    return body;
  }

  return {
    baseUrl: options.baseUrl,

    url(path: string) {
      return joinUrl(options.baseUrl, path);
    },

    /** Read-only request. Cookies are always sent; retries are the caller's decision. */
    request,

    /** Read-only request that must return a JSON body. */
    async json(path: string, init: RequestInit = {}): Promise<JsonValue> {
      return request(path, init, undefined, "json");
    },

    /** Authenticated binary reads, such as private attachment previews. */
    async blob(path: string, init: RequestInit = {}): Promise<Blob> {
      const response = await fetch(joinUrl(options.baseUrl, path), {
        ...init,
        headers: mergeHeaders(options.headers, init.headers),
        credentials,
      });

      if (!response.ok) await throwIfError(response, await parseBody(response));

      return response.blob();
    },

    /** Mutation with CSRF header. JSON bodies set Content-Type; multipart does not. */
    async mutate(path: string, init: RequestInit = {}): Promise<JsonValue> {
      const headers = new Headers({ "x-csrf-protection": "1" });

      if (init.body !== undefined && !(init.body instanceof FormData))
        headers.set("content-type", "application/json");

      return request(path, { ...init, method: init.method ?? "POST" }, headers);
    },

    async streamEvents(input: StreamEventsInput): Promise<void> {
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

      assertContentType(response, "event-stream");

      if (!response.body)
        throw new ThreadApiError(500, "INVALID_RESPONSE", "Event stream was empty");

      input.onOpen?.();
      const validate = input.validate ?? (() => undefined);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const accept = (events: ThreadStreamEvent[]) => {
        for (const event of events) {
          validate(event);
          input.onEvent(event);
        }
      };

      try {
        while (true) {
          const chunk = await reader.read();

          if (chunk.done) break;

          if (chunk.value.byteLength > SSE_MAX_BUFFER_BYTES)
            throw new ThreadApiError(500, "PROTOCOL_ERROR", "Event stream chunk was too large");

          buffer += decoder.decode(chunk.value, { stream: true });

          if (buffer.length > SSE_MAX_BUFFER_BYTES)
            throw new ThreadApiError(
              500,
              "PROTOCOL_ERROR",
              "Event stream frame exceeded the buffer limit",
            );

          const consumed = consumeSse(buffer);

          buffer = consumed.rest;
          accept(consumed.events);
        }

        // An unterminated trailing frame was cut off mid-event; drop it and let
        // the reader reconnect from the last applied cursor.
        accept(consumeSse(buffer + decoder.decode()).events);
      } finally {
        reader.releaseLock();
      }
    },
  };
}

export type ApiTransport = ReturnType<typeof createApiTransport>;

export {
  cancelResultSchema,
  submitResultSchema,
  threadSnapshotSchema,
  type CancelResult,
  type SubmitResult,
  type ThreadSnapshot,
};
