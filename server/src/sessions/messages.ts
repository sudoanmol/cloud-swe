/**
 * Path: server/src/sessions/messages.ts
 * Used by: server/src/sessions/thread.ts.
 * Purpose: Durable message admission: reject, steer or follow up, with operation receipts that make retries idempotent.
 */
import { CancelRunResponse, OperationId, OperationReceipt, Session, SubmitMessageRequest } from '@cloud-swe/protocol';
import { MessageOperation } from '@cloud-swe/protocol/storage';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import { ConversationBusy } from '@earendil-works/pi-durable';

import { apiError } from '../http';
import { type MessageHost, nativeMessage } from './message-state';
import { NOTICE_PREFIX, noticeEntry } from './notice';
import {
  admitMessage,
  currentMessageId,
  hasCancellation,
  readCancellation,
  readMessage,
  readNotice,
  withdrawMessage,
  writeMessage,
} from './thread-store';

async function writeNotice(host: MessageHost, messageId: string, notice: string) {
  const root = await (await host.harness.pi()).root(BG);
  await root.submit({ type: 'write', requestId: NOTICE_PREFIX + messageId, entry: noticeEntry(notice) }, BG);
}

/** Called under the Thread's admission gate; the client connection does not own Pi's run. */
export async function submitMessage(host: MessageHost, session: Session, raw: SubmitMessageRequest): Promise<Response> {
  const request = SubmitMessageRequest.parse(raw);

  if (await hasCancellation(host.storage, request.operationId)) {
    return apiError(409, 'operation_conflict', 'Operation ID already used for a different action');
  }

  const previousMessage = await currentMessageId(host.storage);
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
      await writeMessage(host.storage, { ...operation, state: 'accepted' });

      return Response.json(OperationReceipt.parse(operation.receipt), { status: 202 });
    }
  }

  if (!session.capabilities.submitMessage) {
    return apiError(503, 'unavailable', 'Model credentials or catalog unavailable');
  }

  if (!operation) {
    if (session.run.kind === 'uncertain' || session.run.kind === 'cancelling' || session.pending.length >= 100) {
      return apiError(409, 'busy', 'Session has unresolved work or its input queue is full');
    }

    if (
      request.mode === 'reject' &&
      (session.run.kind === 'running' || session.run.kind === 'retrying' || (await host.harness.session().busy()))
    ) {
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
      notice: await readNotice(host.storage),
    });
    await admitMessage(host.storage, operation);
  }

  try {
    // The write is idempotent by its own request ID, so a retry never delivers the notice twice.
    if (operation.notice) await writeNotice(host, request.operationId, operation.notice);
    await host.harness.submit(request.text, { operationId: request.operationId, whenBusy: request.mode });
  } catch (error) {
    if (error instanceof ConversationBusy) {
      await withdrawMessage(host.storage, request.operationId, previousMessage);

      return apiError(409, 'busy', 'Session is busy');
    }

    // Pi may have committed admission before its receipt was lost.
    return apiError(503, 'unavailable', 'Message admission is unresolved; retry the original operation');
  }

  await writeMessage(host.storage, { ...operation, state: 'accepted' });

  return Response.json(OperationReceipt.parse(operation.receipt), { status: 202 });
}

export async function messageReceipt(host: MessageHost, id: string): Promise<Response> {
  const operation = await readMessage(host.storage, OperationId.parse(id));

  if (!operation) {
    const cancellation = await readCancellation(host.storage, id);

    if (!cancellation) return apiError(404, 'not_found', 'Operation not found');

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
