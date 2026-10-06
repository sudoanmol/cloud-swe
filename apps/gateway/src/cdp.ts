import { readRelayCapability } from "@cloud-swe/db/browser-relay";
import type { BrowserOwner } from "@cloud-swe/db/pi-events";
import { z } from "zod";

import { type Bridge, createBridge, openUpstream } from "./bridge";

export interface CdpRelayOptions {
  secret: string;
  /** True while the thread's workspace runs at this filesystem generation. */
  running(threadId: string, generation: number): Promise<boolean>;
  /** The thread's hosted browser CDP endpoint, started on first use. */
  browser(threadId: string): Promise<string>;
  owner(threadId: string): Promise<BrowserOwner>;
  activity(threadId: string, active: boolean): Promise<void>;
  /** Quiet time after the agent's last command before activity stops. */
  quietMs?: number;
  ownerPollMs?: number;
}

/** The fields of a CDP command the relay needs to answer it in place. */
const commandSchema = z.object({ id: z.number(), sessionId: z.string().optional() });

/** CDP frames are untrusted sandbox output; malformed JSON fails the schema like any bad shape. */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- Callers validate the parsed value with a Zod schema.
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export const userControlMessage =
  "The user controls the browser. Wait, or call request_browser_handoff if you need them to finish something.";

/**
 * Relays the sandbox's agent-browser to the thread's Kernel browser. Kernel
 * credentials stay here; the sandbox holds only a capability for its own
 * thread. The relay marks agent activity for the browser dot and answers the
 * agent's commands with an error while the user has control.
 */
export function createCdpRelay(options: CdpRelayOptions) {
  const quietMs = options.quietMs ?? 10_000;
  const ownerPollMs = options.ownerPollMs ?? 1_000;
  const quiet = new Map<string, ReturnType<typeof setTimeout>>();

  function active(threadId: string) {
    const timer = quiet.get(threadId);

    if (timer) clearTimeout(timer);
    else void options.activity(threadId, true).catch(() => undefined);

    quiet.set(
      threadId,
      setTimeout(() => {
        quiet.delete(threadId);
        void options.activity(threadId, false).catch(() => undefined);
      }, quietMs),
    );
  }

  return {
    async fetch(request: Request, server: Bun.Server<Bridge>): Promise<Response | undefined> {
      const token = new URL(request.url).searchParams.get("cap") ?? "";
      const capability = readRelayCapability(options.secret, token);

      if (!capability) return new Response("Invalid browser capability", { status: 401 });

      if (!(await options.running(capability.threadId, capability.generation)))
        return new Response("The workspace is not running", { status: 403 });

      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
        return new Response("Expected a WebSocket", { status: 426 });

      const threadId = capability.threadId;

      let owner = await options.owner(threadId);

      const upstream = await openUpstream(await options.browser(threadId), {
        headers: new Headers(),
      });

      if (!upstream)
        return new Response("The browser did not accept a connection", { status: 502 });

      // Polling also revokes existing sockets after pause, replacement, or expiry.
      // ponytail: per-connection polling; switch to LISTEN/NOTIFY if relays multiply.
      let polling = false;

      const poll = setInterval(async () => {
        if (polling) return;
        polling = true;

        try {
          if (
            capability.expires <= Date.now() ||
            !(await options.running(threadId, capability.generation))
          ) {
            upstream.close(4001, "Browser capability expired or workspace stopped");

            return;
          }

          owner = await options.owner(threadId);
        } catch {
          // A failed ownership read must not leave agent input enabled.
          owner = "user";
        } finally {
          polling = false;
        }
      }, ownerPollMs);

      const bridge = createBridge(upstream, {
        intercept(client, message) {
          if (owner === "agent") {
            active(threadId);

            return false;
          }

          const command = commandSchema.safeParse(parseJson(String(message)));

          if (command.success)
            client.send(
              JSON.stringify({
                id: command.data.id,
                sessionId: command.data.sessionId || undefined,
                error: { code: -32000, message: userControlMessage },
              }),
            );

          return true;
        },
        onClose: () => clearInterval(poll),
      });

      if (server.upgrade(request, { data: bridge })) return undefined;
      clearInterval(poll);
      upstream.close();

      return new Response("WebSocket upgrade failed", { status: 400 });
    },
  };
}
