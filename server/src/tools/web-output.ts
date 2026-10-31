import { type ToolHost, toolWorkspace } from './host';
import { remoteFileInfo, writeRemoteFile } from './remote';

const DIRECTORY = '.cloud-swe/web';

// A sandbox file write takes 1 MiB, and a UTF-16 unit is at most 3 UTF-8 bytes.
const PART_CHARACTERS = 300_000;

/** Writes a web tool's complete output to the sandbox; a very large one becomes several files. A replayed call overwrites. */
export async function saveWebOutput(host: ToolHost, callId: string, text: string): Promise<string[]> {
  const workspace = await toolWorkspace(host);
  const root = await remoteFileInfo(host.env, workspace, '.', AbortSignal.timeout(5000));
  const name = callId.replace(/[^\w-]/g, '_');
  const paths: string[] = [];

  for (let start = 0; start < text.length; start += PART_CHARACTERS) {
    const suffix = start === 0 ? '' : `.${start / PART_CHARACTERS + 1}`;
    const path = `${root.path.replace(/\/$/, '')}/${DIRECTORY}/${name}${suffix}.md`;

    await writeRemoteFile(
      host.env,
      workspace,
      path,
      text.slice(start, start + PART_CHARACTERS),
      AbortSignal.timeout(30_000),
    );
    paths.push(path);
  }

  return paths;
}
