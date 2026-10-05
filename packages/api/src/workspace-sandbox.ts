import { workspaceReviewProgram } from "@cloud-swe/db/workspace-review-program";
import { ModalClient } from "modal";

/** Runs the read-only review program in a running sandbox and returns its stdout. */
export type WorkspaceReviewRunner = (
  providerId: string,
  args: readonly string[],
) => Promise<string>;

const reviewTimeoutMs = 20_000;

/** Above the guest program's own bounds; a guest that sends more is cut off. */
const maxOutputBytes = 16 * 1024 * 1024;

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) return Buffer.concat(chunks).toString("utf8");
    size += value.byteLength;

    if (size > maxOutputBytes) {
      await reader.cancel();
      throw new Error("Workspace review output exceeded the limit");
    }

    chunks.push(value);
  }
}

/**
 * Read-only review commands bypass the runner's execution coordinator, like
 * the bash journal observer: argv only, `git --no-optional-locks`, a private
 * index, bounded output, and no writes to the checkout.
 */
export function createModalReviewRunner(credentials: {
  tokenId: string;
  tokenSecret: string;
  environment?: string;
}): WorkspaceReviewRunner {
  const client = new ModalClient(credentials);

  return async (providerId, args) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Workspace review timed out")),
        reviewTimeoutMs + 5_000,
      );
    });

    try {
      return await Promise.race([
        (async () => {
          const sandbox = await client.sandboxes.fromId(providerId);

          const child = await sandbox.exec(["python3", "-c", workspaceReviewProgram, ...args], {
            mode: "binary",
            stderr: "ignore",
            timeoutMs: reviewTimeoutMs,
          });

          const stdout = await readBounded(child.stdout);
          const exitCode = await child.wait();

          if (exitCode !== 0) throw new Error(`Workspace review exited with ${exitCode}`);

          return stdout;
        })(),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}
