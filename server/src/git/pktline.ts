/**
 * Path: server/src/git/pktline.ts
 * Used by: server/src/git/{receive-pack,proxy}.ts.
 * Purpose: Reads the command list at the start of a git receive-pack request and writes pkt-line status reports. Never touches the pack.
 */
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
