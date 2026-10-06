/**
 * Preview hostnames are `{port}-{slug}.<PREVIEW_DOMAIN>`: one origin per
 * sandbox port, stable across pauses. The gateway resolves them; the agent and
 * the review panel build them.
 */

/**
 * The guest forwarder's port. Modal routes only to sockets bound to 0.0.0.0, so
 * the gateway always connects here and the forwarder reaches the dev server on
 * loopback.
 */
export const previewForwarderPort = 7999;

const slugPattern = /^[a-f0-9]{32}$/;

export function previewOrigin(domain: string, slug: string, port: number): string {
  return `https://${port}-${slug}.${domain}`;
}

/** The URL template the agent fills in; `{port}` is the only placeholder. */
export function previewUrlTemplate(domain: string, slug: string): string {
  return `https://{port}-${slug}.${domain}`;
}

/** Parses a Host header; null for anything that is not a preview of `domain`. */
export function parsePreviewHost(
  host: string,
  domain: string,
): { port: number; slug: string } | null {
  const hostname = host.toLowerCase().replace(/:\d+$/, "");
  const suffix = `.${domain.toLowerCase()}`;

  if (!hostname.endsWith(suffix)) return null;
  const label = hostname.slice(0, -suffix.length);
  const match = /^(\d{1,5})-([^.]+)$/.exec(label);

  if (!match) return null;
  const port = Number(match[1]);

  if (port < 1 || port > 65_535 || port === previewForwarderPort || !slugPattern.test(match[2]!))
    return null;

  return { port, slug: match[2]! };
}
