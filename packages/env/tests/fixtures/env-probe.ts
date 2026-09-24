import { fileURLToPath } from "node:url";

/**
 * Imports two environment modules in sequence, the way the server does. The
 * first import loads the root `.env` and then `emptyStringAsUndefined` deletes
 * every empty process env key; the second import is where a repeated
 * `loadRootEnv()` would resurrect those keys from `.env`.
 */
const attachmentsModule = fileURLToPath(new URL("../../src/attachments.ts", import.meta.url));

const gitModule = fileURLToPath(new URL("../../src/git.ts", import.meta.url));

await import(attachmentsModule);

const { env } = await import(gitModule);

process.stdout.write(
  JSON.stringify({
    url: env.GIT_BROKER_URL ?? null,
    secret: env.GIT_BROKER_SECRET ?? null,
    storage: env.GIT_BROKER_STORAGE ?? null,
  }),
);
