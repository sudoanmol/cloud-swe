import { RefName } from '@cloud-swe/protocol/git';

const ZERO = '0'.repeat(40);

export type PushCommand = { old: string; new: string; ref: string };

export type PushRequest = {
  commands: PushCommand[];
  capabilities: string[];
  // Anything that is not a plain command list (push certificates, odd lines) is refused, not guessed at.
  unsupported: boolean;
  // Bytes consumed through the flush-pkt that ends the command list.
  length: number;
};

const encoder = new TextEncoder();

const decoder = new TextDecoder();

function hex4(length: number): string {
  return length.toString(16).padStart(4, '0');
}

export type Bytes = Uint8Array<ArrayBuffer>;

/** One pkt-line carrying `body`. */
export function pkt(body: Uint8Array): Bytes {
  const out = new Uint8Array(body.length + 4);
  out.set(encoder.encode(hex4(body.length + 4)));
  out.set(body, 4);

  return out;
}

export const pktText = (text: string) => pkt(encoder.encode(text));

export const FLUSH: Bytes = encoder.encode('0000');

export function concat(parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

const COMMAND = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/;

/**
 * Parses pkt-lines up to the first flush. Returns undefined while the flush has not arrived (read more bytes),
 * and throws on malformed framing.
 */
export function parsePushRequest(bytes: Uint8Array): PushRequest | undefined {
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  let unsupported = false;
  let offset = 0;

  for (;;) {
    if (bytes.length < offset + 4) return undefined;
    const size = Number.parseInt(decoder.decode(bytes.subarray(offset, offset + 4)), 16);

    if (!Number.isInteger(size) || size === 1 || size === 2 || size === 3) throw new Error('Malformed pkt-line');

    if (size === 0) return { commands, capabilities, unsupported, length: offset + 4 };

    if (bytes.length < offset + size) return undefined;
    const payload = bytes.subarray(offset + 4, offset + size);
    offset += size;

    const nul = payload.indexOf(0);
    const line = decoder.decode(nul === -1 ? payload : payload.subarray(0, nul)).replace(/\n$/, '');

    if (commands.length === 0 && nul !== -1) {
      capabilities = decoder
        .decode(payload.subarray(nul + 1))
        .replace(/\n$/, '')
        .split(' ');
    }

    if (line.startsWith('shallow ')) continue;

    const match = COMMAND.exec(line);

    if (!match?.[1] || !match[2] || !match[3]) {
      unsupported = true;
      continue;
    }

    commands.push({ old: match[1], new: match[2], ref: match[3] });
  }
}

export const isZero = (sha: string) => sha === ZERO;

/**
 * A report-status body rejecting `ref`, framed for the sideband the client negotiated. The client prints the
 * reason as `! [remote rejected] ... (reason)`.
 */
export function rejectionReport(ref: string, reason: string, capabilities: string[]): Bytes {
  const inner = concat([pktText('unpack ok\n'), pktText(`ng ${ref} ${reason}\n`), FLUSH]);

  return capabilities.some((cap) => cap === 'side-band-64k' || cap === 'side-band')
    ? concat([pkt(concat([Uint8Array.of(1), inner])), FLUSH])
    : inner;
}

// The command list is tiny; refuse a list that is still incomplete past this, so a pack is never buffered.
export const MAX_COMMANDS_BYTES = 64 * 1024;

/** Reads from `body` until the command list is complete; returns it with a stream of every byte, read or not. */
export async function readCommands(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  let buffered = new Uint8Array(0);
  let request: PushRequest | undefined;

  while (!request) {
    const chunk = await reader.read();

    if (chunk.done) throw new Error('Truncated push request');
    buffered = concat([buffered, chunk.value]);
    // Parse first: a first chunk that also carries the start of the pack is large but valid.
    request = parsePushRequest(buffered);

    if (!request && buffered.length > MAX_COMMANDS_BYTES) throw new Error('Push command list too large');
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(buffered);
    },
    async pull(controller) {
      const next = await reader.read();

      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });

  return { request, stream };
}

/** The last part of every branch this session may push: `cloud-swe/<slug>-<id>`, with the slug chosen by the agent. */
export const branchSuffix = (sessionId: string) => sessionId.slice(0, 8);

export const isSessionBranch = (branch: string, sessionId: string) =>
  new RegExp(`^cloud-swe/[a-z0-9]+(?:-[a-z0-9]+)*-${branchSuffix(sessionId)}$`).test(branch) && branch.length <= 80;

export type PushDecision = { ok: true; command: PushCommand } | { ok: false; reason: string; blocked?: PushCommand };

/** Pure policy over the parsed command list. The pack itself is never inspected. */
export function checkPush(request: PushRequest, sessionId: string): PushDecision {
  if (request.unsupported) return { ok: false, reason: 'unsupported push request' };

  const [command, ...rest] = request.commands;

  if (!command || rest.length > 0) return { ok: false, reason: 'push exactly one ref' };

  const isTag = command.ref.startsWith('refs/tags/');
  const isDelete = isZero(command.new);

  if (isDelete || isTag) {
    // Moving an existing tag has no approval path.
    if (isTag && !isDelete && !isZero(command.old)) return { ok: false, reason: 'moving a tag is not allowed' };

    const reason = isDelete ? 'deleting a ref needs approval' : 'pushing a tag needs approval';

    return RefName.safeParse(command.ref).success ? { ok: false, reason, blocked: command } : { ok: false, reason };
  }

  if (!command.ref.startsWith('refs/heads/') || !isSessionBranch(command.ref.slice(11), sessionId)) {
    return {
      ok: false,
      reason: `only cloud-swe/<slug>-${branchSuffix(sessionId)} may be pushed; use git_request_ref_update for others`,
    };
  }

  return { ok: true, command };
}
