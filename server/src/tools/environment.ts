import { posix } from 'node:path';

import type { WorkspaceRecord } from '@cloud-swe/protocol/storage';
import type { Context } from '@earendil-works/chord/context';
import {
  type BinaryReader,
  err,
  type ExecutionEnv,
  ExecutionError,
  FileError,
  type FileInfo,
  type FileSystem,
  LineScanner,
  ok,
  type Result,
  type Shell,
} from '@earendil-works/pi-durable/env';

import { type ToolHost, toolWorkspace } from './host.ts';
import { createRemoteDirectory, readRemoteBytes, remoteFileInfo, type ToolsEnv, writeRemoteFile } from './remote.ts';

function unsupported(): Promise<Result<never, FileError>> {
  return Promise.resolve(err(new FileError('not_supported', 'Unsupported sandbox filesystem operation')));
}

class SandboxFiles implements FileSystem {
  readonly id: string;
  readonly #bindings: ToolsEnv;
  readonly #workspace: WorkspaceRecord;
  constructor(
    bindings: ToolsEnv,
    workspace: WorkspaceRecord,
    public cwd: string,
  ) {
    this.id = workspace.provider + ':' + workspace.id;
    this.#bindings = bindings;
    this.#workspace = workspace;
  }

  private async request<T>(context: Context, body: (signal: AbortSignal) => Promise<T>): Promise<Result<T, FileError>> {
    const timeout = AbortSignal.timeout(5_000);
    const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, timeout]) : timeout;

    try {
      if (signal.aborted) return err(new FileError('aborted', 'File operation aborted'));

      return ok(await body(signal));
    } catch (error) {
      return err(error instanceof FileError ? error : new FileError('unknown', 'Sandbox file operation failed'));
    }
  }

  async absolutePath(path: string) {
    return ok<string, FileError>(posix.resolve(this.cwd, path));
  }
  async joinPath(parts: string[]) {
    return ok<string, FileError>(posix.join(...parts));
  }
  canonicalPath() {
    return unsupported();
  }

  fileInfo(path: string, context: Context) {
    return this.request<FileInfo>(context, (signal) => remoteFileInfo(this.#bindings, this.#workspace, path, signal));
  }

  async exists(path: string, context: Context) {
    const result = await this.fileInfo(path, context);

    if (result.ok) return ok<boolean, FileError>(true);

    return result.error.code === 'not_found' ? ok<boolean, FileError>(false) : result;
  }

  readTextFile(path: string, context: Context) {
    return this.request(context, async (signal) =>
      new TextDecoder().decode(await readRemoteBytes(this.#bindings, this.#workspace, path, signal)),
    );
  }

  async readBinaryFile(path: string, context: Context) {
    if (/\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(path)) return unsupported();

    return this.request(context, (signal) => readRemoteBytes(this.#bindings, this.#workspace, path, signal));
  }

  async openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    context: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    const metadata = await this.fileInfo(path, context);

    if (!metadata.ok) return metadata;

    if (metadata.value.kind === 'directory' || (metadata.value.kind === 'symlink' && options?.noFollow))
      return err(new FileError('invalid', 'Expected a regular text file'));

    if (metadata.value.size > 5_242_880)
      return err(new FileError('not_supported', 'File is over 5 MiB; read parts of it with bash'));
    const content = await this.readBinaryFile(path, context);

    if (!content.ok) return content;
    const bytes = content.value;

    return ok({
      info: async () => ok({ ...metadata.value, kind: 'file', size: bytes.length }),
      read: async (offset, length) => ok(bytes.slice(offset, offset + length)),
      scanLines: async (options) => {
        const scanner = new LineScanner(options.startLine, options.endLine);
        scanner.push(bytes);

        return ok(scanner.finish());
      },
      close: async () => {},
    });
  }

  writeFile(path: string, content: string | Uint8Array, context: Context) {
    if (content instanceof Uint8Array) return unsupported();

    return this.request(context, (signal) => writeRemoteFile(this.#bindings, this.#workspace, path, content, signal));
  }

  openTextLineReader() {
    return unsupported();
  }
  readTextLines() {
    return unsupported();
  }
  appendFile() {
    return unsupported();
  }
  truncateFile() {
    return unsupported();
  }
  flushFile() {
    return unsupported();
  }
  renameFile() {
    return unsupported();
  }
  listDir() {
    return unsupported();
  }
  openDirReader() {
    return unsupported();
  }
  watch() {
    return unsupported();
  }
  createDir(path: string, _options: { recursive?: boolean } | undefined, context: Context) {
    return this.request(context, (signal) => createRemoteDirectory(this.#bindings, this.#workspace, path, signal));
  }
  remove() {
    return unsupported();
  }
  createTempDir(prefix: string | undefined, context: Context) {
    const path = '/tmp/cloud-swe-' + this.#workspace.id + '-' + (prefix ?? 'tmp-') + crypto.randomUUID();

    return this.request(context, async (signal) => {
      await createRemoteDirectory(this.#bindings, this.#workspace, path, signal);

      return path;
    });
  }
  createTempFile() {
    return unsupported();
  }
  async cleanup() {}
}

class SandboxEnvironment extends SandboxFiles implements ExecutionEnv {
  execute?: Shell['exec'];

  exec: Shell['exec'] = (command, options, context) =>
    this.execute
      ? this.execute(command, options, context)
      : Promise.resolve(err(new ExecutionError('spawn_error', 'Shell requires a native tool invocation')));
}

export async function environment(host: ToolHost, execute?: Shell['exec']): Promise<ExecutionEnv> {
  const workspace = await toolWorkspace(host);
  const root = await remoteFileInfo(host.env, workspace, '.', AbortSignal.timeout(5000));

  if (!root.path.startsWith('/')) throw new Error('Sandbox did not return an absolute working directory');
  const env = new SandboxEnvironment(host.env, workspace, root.path);
  env.execute = execute;

  return env;
}
