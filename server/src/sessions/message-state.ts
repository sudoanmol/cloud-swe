import { OperationId, Session } from '@cloud-swe/protocol';
import { CancelOperation, MessageOperation } from '@cloud-swe/protocol/storage';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import type { PiHarness } from 'agents/harness/pi';

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

    return { run: { kind: 'running', runId }, pending };
  }

  const { runId } = last.receipt;

  if (native.status === 'done') return { run: { kind: 'completed', runId }, pending };

  if (native.status === 'unanswered')
    return {
      run:
        native.reason === 'aborted'
          ? { kind: 'cancelled', runId }
          : { kind: 'failed', runId, message: 'Model request failed' },
      pending,
    };

  // Native admission and the pending scan are separate committed reads; a transition can fall between them.
  return { run: { kind: 'running', runId }, pending };
}
