/**
 * Path: server/src/tools/web-output.ts
 * Used by: server/src/tools/registry.ts.
 * Purpose: Saves a web tool complete output to the sandbox, split only past the direct-write limit.
 */

import { MAX_FILE_BYTES } from '@cloud-swe/protocol/tools';

import { type ToolHost, toolWorkspace } from '../sandbox/host.ts';
import { platformPath, sandboxRoot, writeRemoteFile } from '../sandbox/remote.ts';

// A UTF-16 unit is at most 3 UTF-8 bytes, so a part always fits one sandbox file write.
const PART_CHARACTERS = 1_700_000;

/** Writes a web tool's complete output to the sandbox; only one over the write limit becomes several files. A replayed call overwrites. */
export async function saveWebOutput(host: ToolHost, callId: string, text: string): Promise<string[]> {
  const workspace = await toolWorkspace(host);
  const root = await sandboxRoot(host.env, workspace);
  const name = callId.replace(/[^\w-]/g, '_');
  const paths: string[] = [];
  const size = new TextEncoder().encode(text).length <= MAX_FILE_BYTES ? text.length : PART_CHARACTERS;

  for (let start = 0; start < text.length; start += size) {
    const suffix = start === 0 ? '' : `.${start / size + 1}`;
    const path = platformPath(root, `web/${name}${suffix}.md`);

    await writeRemoteFile(host.env, workspace, path, text.slice(start, start + size), AbortSignal.timeout(30_000));
    paths.push(path);
  }

  return paths;
}
