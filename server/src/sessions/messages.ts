import { OperationId, OperationReceipt, Session, SubmitMessageRequest } from '@cloud-swe/protocol';
import { MessageOperation } from '@cloud-swe/protocol/storage';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import type { Models } from '@earendil-works/pi-ai';
import { ConversationBusy } from '@earendil-works/pi-durable';
import type { PiHarness } from 'agents/harness/pi';

import { apiError } from '../http';

type MessageHost = { storage: DurableObjectStorage; harness: PiHarness };

async function nativeOperation(host: MessageHost, operation: MessageOperation) {
  const root = await (await host.harness.pi()).root(BG);

  return (await host.harness.storage()).submissionByRequest(root.id, operation.request.operationId, BG);
}

async function readOperation(storage: DurableObjectStorage, id: string) {
  const raw = await storage.get<unknown>(`message:${id}`);

  return raw === undefined ? undefined : MessageOperation.parse(raw);
}

export async function currentRun(host: MessageHost): Promise<Session['run']> {
  const raw = await host.storage.get<unknown>('currentMessage');

  if (raw === undefined) return { kind: 'idle' };
  const operation = await readOperation(host.storage, OperationId.parse(raw));

  if (!operation) throw new Error('Missing current message intent');
  const native = await nativeOperation(host, operation);
  const { runId, operationId } = operation.receipt;

  if (!native)
    return {
      kind: 'uncertain',
      runId,
      operationId,
      reason: 'Message admission is unresolved; retry the original operation',
    };

  switch (native.status) {
    case 'queued':
    case 'placed':
      return { kind: 'running', runId };
    case 'done':
      return { kind: 'completed', runId };
    case 'unanswered':
      return native.reason === 'aborted'
        ? { kind: 'cancelled', runId }
        : { kind: 'failed', runId, message: 'Model request failed' };
    default: {
      const exhaustive: never = native;

      return exhaustive;
    }
  }
}

/** Called under the Thread's admission gate; the client connection does not own Pi's run. */
export async function submitMessage(
  host: MessageHost,
  models: Models,
  session: Session,
  raw: SubmitMessageRequest,
): Promise<Response> {
  const request = SubmitMessageRequest.parse(raw);
  const previousMessage = await host.storage.get<unknown>('currentMessage');
  let operation = await readOperation(host.storage, request.operationId);

  if (operation) {
    if (
      JSON.stringify(operation.request) !== JSON.stringify(request) ||
      JSON.stringify(operation.model) !== JSON.stringify(session.model)
    ) {
      return apiError(409, 'operation_conflict', 'Operation ID already used for a different request');
    }

    // A crash may leave the application receipt pending after Pi already admitted it.
    if (operation.state === 'accepted' || (await nativeOperation(host, operation))) {
      await host.storage.put(`message:${request.operationId}`, { ...operation, state: 'accepted' });

      return Response.json(OperationReceipt.parse(operation.receipt), { status: 202 });
    }
  }

  if (!models.getModel(session.model.provider, session.model.id) || !(await models.checkAuth(session.model.provider))) {
    return apiError(503, 'unavailable', 'Model credentials or catalog unavailable');
  }

  if (!operation) {
    const run = await currentRun(host);

    if (
      run.kind === 'running' ||
      run.kind === 'cancelling' ||
      run.kind === 'uncertain' ||
      (await host.harness.session().busy())
    ) {
      return apiError(409, 'busy', 'Session has unresolved work');
    }

    operation = MessageOperation.parse({
      request,
      model: session.model,
      receipt: {
        operationId: request.operationId,
        sessionId: session.id,
        runId: crypto.randomUUID(),
        action: 'submit_message',
        status: 'accepted',
        acceptedAt: new Date().toISOString(),
      },
      state: 'prepared',
    });
    await host.storage.put({ [`message:${request.operationId}`]: operation, currentMessage: request.operationId });
  }

  try {
    await host.harness.submit(request.text, { operationId: request.operationId, whenBusy: 'reject' });
  } catch (error) {
    if (error instanceof ConversationBusy) {
      await host.storage.transaction(async (tx) => {
        await tx.delete(`message:${request.operationId}`);

        if (previousMessage === undefined || previousMessage === request.operationId) await tx.delete('currentMessage');
        else await tx.put('currentMessage', OperationId.parse(previousMessage));
      });

      return apiError(409, 'busy', 'Session is busy');
    }

    // Pi may have committed admission before its receipt was lost.
    return apiError(503, 'unavailable', 'Message admission is unresolved; retry the original operation');
  }

  await host.storage.put(`message:${request.operationId}`, { ...operation, state: 'accepted' });

  return Response.json(OperationReceipt.parse(operation.receipt), { status: 202 });
}

export async function messageReceipt(host: MessageHost, id: string): Promise<Response> {
  const operation = await readOperation(host.storage, OperationId.parse(id));

  if (!operation) return apiError(404, 'not_found', 'Operation not found');

  if (operation.state !== 'accepted' && !(await nativeOperation(host, operation))) {
    return apiError(503, 'unavailable', 'Message admission is unresolved; retry the original operation');
  }

  return Response.json(OperationReceipt.parse(operation.receipt));
}
