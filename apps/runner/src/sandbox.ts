import type { SandboxProviderName } from "@cloud-swe/db/thread-contracts";

export type WorkspaceRef = {
  name: string;
  providerId: string | null;
  provider: SandboxProviderName;
};

export type SandboxProviders = Partial<Record<SandboxProviderName, SandboxProvider>>;

export type CommandRequest = {
  command: string;
  stdin?: string;
  timeoutMs?: number;
};

export type CommandResult = {
  stdout: string;
  stderr: string;
  statusCode: number | null;
};

export interface SandboxProvider {
  ensure(workspace: WorkspaceRef, signal: AbortSignal): Promise<{ providerId: string }>;
  ensure(name: string, signal: AbortSignal): Promise<{ providerId: string }>;
  exec(
    workspace: WorkspaceRef,
    request: CommandRequest,
    signal: AbortSignal,
  ): Promise<CommandResult>;
  exec(workspace: WorkspaceRef, command: string, signal: AbortSignal): Promise<CommandResult>;
  exec(name: string, request: CommandRequest, signal: AbortSignal): Promise<CommandResult>;
  execStep(
    workspace: WorkspaceRef,
    runId: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<string>;
  execStep(name: string, runId: string, prompt: string, signal: AbortSignal): Promise<string>;
  pause(workspace: WorkspaceRef, signal: AbortSignal): Promise<boolean>;
  pause(name: string, signal: AbortSignal): Promise<boolean>;
  delete(workspace: WorkspaceRef, signal: AbortSignal): Promise<void>;
  delete(name: string, signal: AbortSignal): Promise<void>;
}

export function workspaceRef(workspace: WorkspaceRef | string): WorkspaceRef {
  return typeof workspace === "string"
    ? { name: workspace, providerId: null, provider: "docker" }
    : workspace;
}
