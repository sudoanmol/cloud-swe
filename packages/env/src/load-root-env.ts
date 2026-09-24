import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

function findRepositoryRoot(start: string): string | undefined {
  let directory = start;
  const filesystemRoot = parse(directory).root;

  while (directory !== filesystemRoot) {
    if (existsSync(join(directory, "turbo.json")) && existsSync(join(directory, "package.json"))) {
      return directory;
    }

    directory = dirname(directory);
  }

  return undefined;
}

let loaded = false;

export function loadRootEnv(): void {
  // Every environment module calls this on import. A second load would
  // resurrect keys that `emptyStringAsUndefined` deleted from an explicit empty
  // override, silently replacing it with the value from `.env`.
  if (loaded) return;

  loaded = true;

  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = findRepositoryRoot(process.cwd()) ?? findRepositoryRoot(moduleDirectory);

  // Deployments may run a compiled bundle outside the repository. In that case
  // configuration is injected by the process environment instead of a local file.
  if (!repositoryRoot) return;

  dotenv.config({ path: join(repositoryRoot, ".env"), quiet: true });
}
