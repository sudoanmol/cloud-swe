import { CancelRunResponse, OperationId, OperationReceipt, Session, SubmitMessageRequest } from '@cloud-swe/protocol';
import { CancelOperation, MessageOperation } from '@cloud-swe/protocol/storage';
import type { Models } from '@earendil-works/pi-ai';
import { ConversationBusy } from '@earendil-works/pi-durable';

import { apiError } from '../http';
import { type MessageHost, nativeMessage, readMessage } from './message-state';

/** Called under the Thread's admission gate; the client connection does not own Pi's run. */
export async function submitMessage(
  host: MessageHost,
  models: Models,
  session: Session,
  raw: SubmitMessageRequest,
): Promise<Response> {
  const request = SubmitMessageRequest.parse(raw);

  if ((await host.storage.get(`cancel:${request.operationId}`)) !== undefined) {
    return apiError(409, 'operation_conflict', 'Operation ID already used for a different action');
  }

  const previousMessage = await host.storage.get<unknown>('currentMessage');
  let operation = await readMessage(host.storage, request.operationId);

  if (operation) {
    if (
      JSON.stringify(operation.request) !== JSON.stringify(request) ||
      JSON.stringify(operation.model) !== JSON.stringify(session.model)
    ) {
      return apiError(409, 'operation_conflict', 'Operation ID already used for a different request');
    }

    // A crash may leave the application receipt pending after Pi already admitted it.
    if (operation.state === 'accepted' || (await nativeMessage(host, request.operationId))) {
      await host.storage.put(`message:${request.operationId}`, { ...operation, state: 'accepted' });

      return Response.json(OperationReceipt.parse(operation.receipt), { status: 202 });
    }
  }

  if (!models.getModel(session.model.provider, session.model.id) || !(await models.checkAuth(session.model.provider))) {
    return apiError(503, 'unavailable', 'Model credentials or catalog unavailable');
  }

  if (!operation) {
    if (session.run.kind === 'uncertain' || session.run.kind === 'cancelling' || session.pending.length >= 100) {
      return apiError(409, 'busy', 'Session has unresolved work or its input queue is full');
    }

    if (request.mode === 'reject' && (session.run.kind === 'running' || (await host.harness.session().busy()))) {
      return apiError(409, 'busy', 'Session is busy');
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
    await host.harness.submit(request.text, { operationId: request.operationId, whenBusy: request.mode });
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
  const operation = await readMessage(host.storage, OperationId.parse(id));

  if (!operation) {
    const raw = await host.storage.get<unknown>(`cancel:${id}`);

    if (raw === undefined) return apiError(404, 'not_found', 'Operation not found');
    const cancellation = CancelOperation.parse(raw);

    if (cancellation.state !== 'accepted') {
      return apiError(503, 'unavailable', 'Cancellation is unresolved; retry the original operation');
    }

    return Response.json(CancelRunResponse.parse(cancellation.receipt));
  }

  if (operation.state !== 'accepted' && !(await nativeMessage(host, operation.request.operationId))) {
    return apiError(503, 'unavailable', 'Message admission is unresolved; retry the original operation');
  }

  return Response.json(OperationReceipt.parse(operation.receipt));
}
