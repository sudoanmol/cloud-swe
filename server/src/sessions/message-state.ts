import { OperationId, Session } from '@cloud-swe/protocol';
import { NativeDetail } from '@cloud-swe/protocol/native';
import { CancelOperation, MessageOperation } from '@cloud-swe/protocol/storage';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import { LiveDoc } from '@earendil-works/pi-durable';
import type { PiHarness } from 'agents/harness/pi';

import { failureFromDetail } from './model-failure.ts';

export type MessageHost = { storage: DurableObjectStorage; harness: PiHarness };

export async function nativeMessage(host: MessageHost, operationId: string) {
  const root = await (await host.harness.pi()).root(BG);

  return (await host.harness.storage()).submissionByRequest(root.id, operationId, BG);
}

export async function readMessage(storage: DurableObjectStorage, id: string) {
  const raw = await storage.get<unknown>(`message:${id}`);

  return raw === undefined ? undefined : MessageOperation.parse(raw);
}

export async function pendingMessages(host: MessageHost) {
  return Promise.all(
    (await host.harness.pending()).map(async (native) => {
      const operation = await readMessage(host.storage, native.operationId);

      if (!operation) throw new Error('Missing native message intent');

      return { operation, status: native.status };
    }),
  );
}

// Only model errors carry provider-derived text; every other settlement is our own fault to report, not a model failure.
function settledFailure(reason: string | undefined, detail: string | undefined) {
  if (reason === 'model_error') return failureFromDetail(detail);

  if (reason === 'no_model') return { code: 'internal', message: 'The configured model is not available' } as const;

  if (reason === 'stale') return { code: 'internal', message: 'The message was discarded before it ran' } as const;

  return { code: 'internal', message: 'The run ended because of an internal fault' } as const;
}

async function liveRetry(host: MessageHost) {
  const pi = await host.harness.pi();
  const root = await pi.root(BG);

  return pi.commit(async (tx) => {
    const retry = (await tx.doc(LiveDoc, root.id)).generation?.retry;

    // A document draft does not outlive its transaction.
    return retry && { at: retry.at, error: retry.error };
  }, BG);
}

export async function messageState(host: MessageHost): Promise<Pick<Session, 'run' | 'pending'>> {
  const current = await host.storage.get<unknown>('currentMessage');

  if (current === undefined) return { run: { kind: 'idle' }, pending: [] };
  const last = await readMessage(host.storage, OperationId.parse(current));

  if (!last) throw new Error('Missing current message intent');
  const native = await nativeMessage(host, last.request.operationId);
  const messages = await pendingMessages(host);

  const pending = messages.map(({ operation, status }) => ({
    operationId: operation.request.operationId,
    runId: operation.receipt.runId,
    mode: operation.request.mode,
    status,
  }));

  if (!native)
    return {
      run: {
        kind: 'uncertain',
        runId: last.receipt.runId,
        operationId: last.request.operationId,
        reason: 'Message admission is unresolved; retry the original operation',
      },
      pending,
    };

  // Pi owns ordering. A queued steer may join the current generation; follow-ups wait for its end.
  const active = messages.find((message) => message.status !== 'queued') ?? messages[0];

  if (active) {
    const runId = active.operation.receipt.runId;
    const cancelId = await host.storage.get<unknown>('currentCancellation');

    if (cancelId !== undefined) {
      const cancellation = CancelOperation.parse(
        await host.storage.get<unknown>(`cancel:${OperationId.parse(cancelId)}`),
      );

      if (
        cancellation.receipt.runId === runId ||
        messages.some(
          (message) =>
            cancellation.messageOperationIds.includes(message.operation.request.operationId) &&
            message.status !== 'queued',
        )
      )
        return { run: { kind: 'cancelling', runId }, pending };
    }

    const retry = await liveRetry(host);

    if (retry)
      return {
        run: {
          kind: 'retrying',
          runId,
          ...failureFromDetail(retry.error),
          nextAttemptAt: new Date(retry.at).toISOString(),
        },
        pending,
      };

    return { run: { kind: 'running', runId }, pending };
  }

  const { runId } = last.receipt;

  if (native.status === 'done') return { run: { kind: 'completed', runId }, pending };

  if (native.status === 'unanswered')
    return {
      run:
        native.reason === 'aborted'
          ? { kind: 'cancelled', runId }
          : { kind: 'failed', runId, ...settledFailure(native.reason, NativeDetail.parse(native.detail)) },
      pending,
    };

  // Native admission and the pending scan are separate committed reads; a transition can fall between them.
  return { run: { kind: 'running', runId }, pending };
}
