import { Session } from '@cloud-swe/protocol';
import { MessageOperation, type WorkspaceRecord } from '@cloud-swe/protocol/storage';
import { CommandOperation, ShellInput, type ShellProgress } from '@cloud-swe/protocol/tools';
import { BACKGROUND_CONTEXT as BG, type Context } from '@earendil-works/chord/context';
import { LiveDoc, type ToolExecutionApi } from '@earendil-works/pi-durable';
import {
  err,
  ExecutionError,
  ok,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
} from '@earendil-works/pi-durable/env';
import { Effect } from 'effect';

import {
  isOpen,
  markNotStarted,
  markUncertain,
  pollCommand,
  saveCommand,
  unresolvedReason as reason,
} from './command-records';
import { hasUnresolvedCommands } from './command-state';
import type { ToolHost } from './host';
import { dispatchRemoteCommand } from './remote';
import { BASH_MAX_TIMEOUT_SECONDS, commandPrefix, supervisorCommand } from './runner';

async function prepare(
  host: ToolHost,
  api: ToolExecutionApi,
  input: ShellInput,
): Promise<{ operation: CommandOperation; fresh: boolean } | null> {
  const intent = JSON.stringify(input);
  const existing = await host.storage.get<unknown>('command:' + api.taskId);

  if (existing !== undefined) {
    const operation = CommandOperation.parse(existing);

    if (operation.intent !== intent || operation.toolCallId !== api.callId) throw new Error('Command intent changed');

    return { operation, fresh: false };
  }

  if (await hasUnresolvedCommands(host)) return null;

  const binding = await api.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, api.conversationId);
    const first = live.run?.inputs[0];

    if (!first) throw new Error('Missing native run binding');

    return {
      id: first,
      parentToolCallId: live.nestedTools?.find((slot) => slot.taskId === api.taskId)?.parentCallId ?? null,
    };
  }, BG);

  const native = await (await host.harness.storage()).submission(binding.id, BG);

  if (!native?.requestId) throw new Error('Missing native input binding');
  const message = MessageOperation.parse(await host.storage.get<unknown>('message:' + native.requestId));
  const session = Session.parse(await host.storage.get<unknown>('session'));

  const operation = CommandOperation.parse({
    record: {
      kind: 'prepared',
      identity: {
        workspaceId: session.workspace.id,
        operationId: crypto.randomUUID(),
      },
      cancelRequested: false,
      heartbeat: 0,
      lastSeenAt: Date.now(),
      output: '',
      outputBytes: 0,
    },
    nativeTaskId: api.taskId,
    toolCallId: api.callId,
    parentToolCallId: binding.parentToolCallId,
    messageOperationId: native.requestId,
    runId: message.receipt.runId,
    intent,
  });

  await saveCommand(host, operation);

  return { operation, fresh: true };
}

export async function executeCommand(
  host: ToolHost,
  workspace: WorkspaceRecord,
  api: ToolExecutionApi,
  command: string | readonly string[],
  options: ShellExecOptions | undefined,
  context: Context,
): Promise<Result<ShellExecResult, ExecutionError>> {
  if (Array.isArray(command)) return err(new ExecutionError('spawn_error', 'Only bash string commands are supported'));

  const input = ShellInput.safeParse({
    command,
    cwd: options?.cwd,
    timeoutSeconds: options?.timeout ?? BASH_MAX_TIMEOUT_SECONDS,
  });

  if (!input.success)
    return err(new ExecutionError('spawn_error', 'Command exceeds sandbox limits: 16000 characters, 600 seconds'));
  const prepared = await prepare(host, api, input.data);

  if (!prepared) return err(new ExecutionError('unknown', reason));
  const { operation, fresh } = prepared;

  if (operation.record.kind === 'not_started') return err(new ExecutionError('aborted', 'Command was not started'));

  if (fresh) {
    if (context.abortSignal?.aborted) {
      await markNotStarted(host, operation);

      return err(new ExecutionError('aborted', 'Command was not started'));
    }

    try {
      await dispatchRemoteCommand(
        host.env,
        workspace,
        supervisorCommand(operation.record.identity, input.data),
        AbortSignal.timeout(5000),
      );
    } catch {
      // A failed receipt does not mean dispatch failed. Inspect this UUID; never resend the shell command.
    }
  }

  // Pi clears a replayed tool's progress; rebuild it from the same remote job.
  let seenBytes = 0;

  const onProgress = async (progress: ShellProgress) => {
    const delta = progress.outputBytes - seenBytes;

    if (delta > 0) {
      const bytes = new TextEncoder().encode(progress.output);
      const available = Math.min(delta, bytes.length);
      const text = new TextDecoder().decode(bytes.slice(bytes.length - available));
      options?.onOutput?.(text, context, { stream: 'stdout' });

      if (delta > bytes.length)
        api.diagnostic({
          severity: 'warn',
          code: 'truncated',
          message: 'Remote output exceeded the retained window; full output is in the sandbox spill file',
        });
      seenBytes = progress.outputBytes;
    }

    await api.details(
      { operationId: progress.identity.operationId, status: progress.kind, outputBytes: progress.outputBytes },
      context,
    );
  };

  try {
    const { operation: settled, progress } = await Effect.runPromise(
      pollCommand(host, workspace, operation, {
        every: '500 millis',
        deadline: input.data.timeoutSeconds * 1000 + 15_000,
        onProgress,
      }),
      { signal: context.abortSignal },
    );

    if (settled.record.kind === 'lost') return err(new ExecutionError('unknown', settled.record.reason));

    if (progress?.kind !== 'exited' || isOpen(settled)) return err(new ExecutionError('unknown', reason));

    if (progress.termination !== 'exit')
      return err(
        new ExecutionError(
          progress.termination === 'timeout' ? 'timeout' : 'aborted',
          'Remote command ' + progress.termination,
        ),
      );
    const result: ShellExecResult = { exitCode: progress.exitCode };

    if (progress.outputBytes > 50_000) result.spillPath = commandPrefix(progress.identity) + '.log';

    return ok(result);
  } catch {
    await markUncertain(host, operation);

    return err(new ExecutionError('unknown', reason));
  }
}
