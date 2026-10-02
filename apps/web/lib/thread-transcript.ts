import type {
  OptimisticMessage,
  ProjectedRun,
  ProjectedTextPart,
  SnapshotMessage,
  SnapshotRun,
  ThreadProjection,
  TranscriptEntry,
} from "./chat-types";

/** Snapshot messages are reconciled by run identity, never by matching reply text. */
export function buildTranscript(input: {
  snapshotMessages: readonly SnapshotMessage[];
  snapshotRuns: readonly SnapshotRun[];
  projection: ThreadProjection;
  optimistic: readonly OptimisticMessage[];
  snapshotWatermark?: number;
}): TranscriptEntry[] {
  const { snapshotMessages, snapshotRuns, projection, optimistic } = input;
  const entries: TranscriptEntry[] = [];
  const claimedMessages = new Set<string>();
  const claimedRuns = new Set<string>();
  const watermark = input.snapshotWatermark ?? 0;
  const messagesByRun = Map.groupBy(snapshotMessages, (message) => message.runId);
  const projectedByRun = new Map(projection.runs.map((run) => [run.runId, run]));
  const optimisticByRun = new Map(optimistic.map((message) => [message.runId, message]));

  for (const run of snapshotRuns) {
    claimedRuns.add(run.id);

    const messages = messagesByRun.get(run.id) ?? [];
    const prompt = messages.find((message) => message.role === "user");

    const pending = optimisticByRun.get(run.id);

    if (prompt) {
      claimedMessages.add(prompt.id);
      entries.push(userEntry(prompt));
    } else if (pending) entries.push(optimisticEntry(pending));

    const projected = projectedByRun.get(run.id);

    const status =
      projected && projected.statusSequence > watermark ? projected.status : run.status;

    const parts = projected ? runPartEntries({ ...projected, status }) : [];

    const persisted = messages.find((message) => message.role === "assistant");

    if (persisted) {
      claimedMessages.add(persisted.id);
      let finalIndex = -1;

      for (let index = parts.length - 1; index >= 0; index--) {
        const entry = parts[index];

        if (entry?.kind !== "assistant") continue;
        // A cold replay may still be reading commentary before a tool. Do not
        // overwrite that commentary with a newer snapshot's final response.

        if (
          projection.cursor >= watermark ||
          entry.part.stopReason === "stop" ||
          entry.part.stopReason === "length"
        )
          finalIndex = index;
        break;
      }

      const streamed = parts[finalIndex];

      if (streamed?.kind === "assistant") {
        parts[finalIndex] = {
          ...streamed,
          part: { ...streamed.part, text: persisted.content, state: "final", truncated: false },
        };
      } else
        parts.push({
          kind: "assistant",
          key: `persisted:${persisted.id}`,
          part: persistedTextPart(persisted),
        });
    }

    entries.push(...parts);
  }

  for (const run of projection.runs) {
    if (claimedRuns.has(run.runId)) continue;
    const pending = optimisticByRun.get(run.runId);

    if (pending) entries.push(optimisticEntry(pending));
    entries.push(...runPartEntries(run));
  }

  for (const message of snapshotMessages) {
    if (claimedMessages.has(message.id)) continue;

    if (message.role === "user") entries.push(userEntry(message));
    else if (message.role === "assistant")
      entries.push({
        kind: "assistant",
        key: `persisted:${message.id}`,
        part: persistedTextPart(message),
      });
  }

  for (const message of optimistic) {
    if (
      !entries.some(
        (entry) => entry.kind === "user" && entry.clientMessageId === message.clientMessageId,
      )
    )
      entries.push(optimisticEntry(message));
  }

  for (const notice of projection.notices)
    entries.push({ kind: "marker", key: notice.key, text: notice.text, tone: notice.tone });

  for (const [index, text] of projection.unsupported.entries())
    entries.push({ kind: "marker", key: `unsupported:${index}`, text, tone: "warning" });

  return entries;
}

function userEntry(message: SnapshotMessage): TranscriptEntry {
  return {
    kind: "user",
    key: `message:${message.id}`,
    text: message.content,
    createdAt: message.createdAt,
    attachments: message.attachments,
    pending: false,
    runId: message.runId,
    clientMessageId: message.clientMessageId,
  };
}

function optimisticEntry(message: OptimisticMessage): TranscriptEntry {
  return {
    kind: "user",
    key: `optimistic:${message.clientMessageId}`,
    text: message.text,
    createdAt: null,
    attachments: [],
    pending: true,
    runId: message.runId,
    clientMessageId: message.clientMessageId,
  };
}

function persistedTextPart(message: SnapshotMessage): ProjectedTextPart {
  return {
    kind: "text",
    key: `persisted:${message.id}`,
    identity: {
      attemptId: `persisted:${message.runId ?? message.id}`,
      assistantAttempt: 1,
      messageIndex: 1,
    },
    legacy: false,
    text: message.content,
    state: "final",
    truncated: false,
  };
}

function runPartEntries(run: ProjectedRun): TranscriptEntry[] {
  return run.parts.map((part): TranscriptEntry => {
    if (part.kind === "text")
      return {
        kind: "assistant",
        key: part.key,
        part:
          part.state === "streaming" && isTerminal(run)
            ? { ...part, state: run.status === "completed" ? "final" : "partial" }
            : part,
      };

    if (part.kind === "tool") return { kind: "tool", key: part.key, runId: run.runId, part };

    return part;
  });
}

export function isTerminal(run: { status: string }): boolean {
  return run.status === "completed" || run.status === "failed" || run.status === "cancelled";
}

export function isActiveRun(run: { status: string }): boolean {
  return run.status === "queued" || run.status === "running" || run.status === "unknown";
}
