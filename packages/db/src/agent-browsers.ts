import { ConflictError, Kernel, NotFoundError } from "@onkernel/sdk";

/**
 * One hosted Kernel browser per thread, named after it, so the active session
 * is found by name instead of stored. Its profile, also named after the
 * thread, keeps cookies and storage across sessions; Kernel saves it when the
 * session ends, including by idle timeout after the workspace pauses.
 */
export type AgentBrowser = {
  /** JWT-authenticated CDP endpoint; only the gateway relay connects to it. */
  cdpUrl: string;
  /** JWT-authenticated live view for the user's iframe. */
  liveViewUrl: string | null;
};

export interface AgentBrowsers {
  /** The running browser, created on first use. */
  ensure(threadId: string): Promise<AgentBrowser>;
  /** The running browser, or null when none is active. */
  find(threadId: string): Promise<AgentBrowser | null>;
  /** Ends the session and deletes the saved profile with its logins. */
  forget(threadId: string): Promise<void>;
}

export function agentBrowserName(threadId: string): string {
  return `cloud-swe-${threadId}`;
}

function view(browser: { cdp_ws_url: string; browser_live_view_url?: string }): AgentBrowser {
  return { cdpUrl: browser.cdp_ws_url, liveViewUrl: browser.browser_live_view_url ?? null };
}

async function ignore(status: typeof NotFoundError | typeof ConflictError, call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    if (!(error instanceof status)) throw error;
  }
}

export function createAgentBrowsers(options: {
  apiKey: string;
  /** Idle seconds before Kernel ends the session; matches the workspace idle pause. */
  idleSeconds: number;
}): AgentBrowsers {
  const client = new Kernel({ apiKey: options.apiKey });

  async function find(threadId: string) {
    try {
      return view(await client.browsers.retrieve(agentBrowserName(threadId)));
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  return {
    find,
    async ensure(threadId) {
      const existing = await find(threadId);

      if (existing) return existing;
      const name = agentBrowserName(threadId);
      await ignore(ConflictError, client.profiles.create({ name }));

      try {
        return view(
          await client.browsers.create({
            name,
            headless: false,
            profile: { name, save_changes: true },
            timeout_seconds: options.idleSeconds,
          }),
        );
      } catch (error) {
        // A concurrent first use created it; the name is unique among active sessions.
        const raced = error instanceof ConflictError ? await find(threadId) : null;

        if (raced) return raced;
        throw error;
      }
    },
    async forget(threadId) {
      const name = agentBrowserName(threadId);
      await ignore(NotFoundError, client.browsers.deleteByID(name));
      await ignore(NotFoundError, client.profiles.delete(name));
    },
  };
}
