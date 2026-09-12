export function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function boundedUtf8(value: string, maxBytes: number) {
  const bytes = Buffer.from(value, "utf8");

  if (bytes.byteLength <= maxBytes) return { text: value, truncated: false };
  let end = Math.max(0, Math.floor(maxBytes));

  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;

  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}
