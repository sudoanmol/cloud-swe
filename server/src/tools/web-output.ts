/**
 * Path: server/src/tools/web-output.ts
 * Used by: server/src/tools/registry.ts.
 * Purpose: Saves a web tool complete output to the sandbox, split only past the direct-write limit.
 */

import { type ToolHost, toolWorkspace } from '../sandbox/host.ts';
import { sandboxRoot, writeRemoteFile } from '../sandbox/remote.ts';

const DIRECTORY = '.cloud-swe/web';

// A sandbox file write takes 5 MiB, and a UTF-16 unit is at most 3 UTF-8 bytes.
const WRITE_BYTES = 5_242_880;
const PART_CHARACTERS = 1_700_000;

/** Writes a web tool's complete output to the sandbox; only one over the write limit becomes several files. A replayed call overwrites. */
export async function saveWebOutput(host: ToolHost, callId: string, text: string): Promise<string[]> {
  const workspace = await toolWorkspace(host);
  const root = await sandboxRoot(host.env, workspace);
  const name = callId.replace(/[^\w-]/g, '_');
  const paths: string[] = [];
  const size = new TextEncoder().encode(text).length <= WRITE_BYTES ? text.length : PART_CHARACTERS;

  for (let start = 0; start < text.length; start += size) {
    const suffix = start === 0 ? '' : `.${start / size + 1}`;
    const path = `${root.replace(/\/$/, '')}/${DIRECTORY}/${name}${suffix}.md`;

    await writeRemoteFile(host.env, workspace, path, text.slice(start, start + size), AbortSignal.timeout(30_000));
    paths.push(path);
  }

  return paths;
}
