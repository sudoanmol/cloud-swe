/**
 * Path: server/src/sessions/messages.ts
 * Used by: server/src/sessions/{cancellation,projection,thread}.ts.
 * Purpose: Message admission through Pi inbox and receipt lookup, and the projection of native input state onto the session (pending inputs, run, failure).
 */

import {
  CancelRunResponse,
  OperationReceipt,
  PENDING_INPUTS_LIMIT,
  type Session,
  type SubmitMessageRequest,
} from '@cloud-swe/protocol';
import { NativeDetail } from '@cloud-swe/protocol/native';
import { MessageOperation } from '@cloud-swe/protocol/storage';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import { ConversationBusy, LiveDoc } from '@earendil-works/pi-durable';
import type { PiHarness } from 'agents/harness/pi';

import { type ApiFailure, failure, type Result, success } from '../errors.ts';
import {
  acceptMessage,
  admitMessage,
  currentCancellation,
  currentMessageId,
  hasCancellation,
  hasRewind,
  readCancellation,
  readMessage,
  readNotice,
  withdrawMessage,
} from '../thread-store.ts';
import { messageInput } from './attachments.ts';
import { failureFromDetail } from './failures.ts';
import { sameRequest } from './idempotency.ts';
import { isNotice, writeNotice } from './notice.ts';
import { requireConversation } from './pi.ts';

export type MessageHost = { storage: DurableObjectStorage; harness: PiHarness };

/** Pi's submission for a message, looked up in the conversation its receipt names. */
export async function nativeMessage(host: MessageHost, operation: MessageOperation) {
  const conversation = await requireConversation(host.harness, operation.receipt.conversationId);

  return (await host.harness.storage()).submissionByRequest(conversation.id, operation.request.operationId, BG);
}

export async function pendingMessages(host: MessageHost, conversationId: string) {
  return Promise.all(
    // A queued notice write shares Pi's request namespace but is not a message.
    (await host.harness.pending({ session: conversationId }))
      .filter((native) => !isNotice(native.operationId))
      .map(async (native) => {
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

async function liveRetry(host: MessageHost, conversationId: string) {
  const conversation = await requireConversation(host.harness, conversationId);

  return conversation.commit(async (tx) => {
    const retry = (await tx.doc(LiveDoc, conversation.id)).generation?.retry;

    // A document draft does not outlive its transaction.
    return retry && { at: retry.at, error: retry.error };
  }, BG);
}

/** The conversation's run and its messages Pi has not settled. */
export async function messageState(
  host: MessageHost,
  conversationId: string,
): Promise<Pick<Session, 'run' | 'pending'>> {
  const current = await currentMessageId(host.storage, conversationId);

  if (current === undefined) return { run: { kind: 'idle' }, pending: [] };
  const last = await readMessage(host.storage, current);

  if (!last) throw new Error('Missing current message intent');
  const native = await nativeMessage(host, last);
  const messages = await pendingMessages(host, conversationId);

  const pending = messages.map(({ operation, status }) => ({
    operationId: operation.request.operationId,
    runId: operation.receipt.runId,
    mode: operation.request.mode,
    status,
    text: operation.request.text,
    attachments: operation.request.attachments ?? [],
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
    const cancellation = await currentCancellation(host.storage, conversationId);

    if (cancellation) {
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

    const retry = await liveRetry(host, conversationId);

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

/** Why the active conversation can't take a new message now, if it can't. */
async function admissionRefusal(
  host: MessageHost,
  session: Session,
  request: SubmitMessageRequest,
): Promise<ApiFailure | undefined> {
  if (session.pending.length >= PENDING_INPUTS_LIMIT) return failure('input_queue_full');

  if (session.run.kind === 'uncertain' || session.run.kind === 'cancelling') return failure('session_settling');

  if (request.mode !== 'reject') return undefined;

  const busy =
    session.run.kind === 'running' ||
    session.run.kind === 'retrying' ||
    (await host.harness.session(session.activeConversationId).busy());

  return busy ? failure('session_busy') : undefined;
}

/**
 * Called under the Thread's admission gate; the client connection does not own Pi's run. A new message goes only to the
 * session's active conversation. A retry is the same request only for the conversation it was admitted to.
 */
export async function submitMessage(
  host: MessageHost,
  session: Session,
  conversationId: string,
  request: SubmitMessageRequest,
  modelReady: boolean,
  system?: true,
): Promise<Result<OperationReceipt>> {
  if (
    (await hasCancellation(host.storage, request.operationId)) ||
    (await hasRewind(host.storage, request.operationId))
  )
    return failure('operation_conflict');

  const previousMessage = await currentMessageId(host.storage, conversationId);
  let operation = await readMessage(host.storage, request.operationId);

  if (operation) {
    if (
      operation.receipt.conversationId !== conversationId ||
      !sameRequest(operation.request, MessageOperation.shape.request.parse(request)) ||
      !sameRequest(operation.model, MessageOperation.shape.model.parse(session.model))
    ) {
      return failure('operation_conflict');
    }

    // A crash may leave the application receipt pending after Pi already admitted it.
    if (operation.state === 'accepted' || (await nativeMessage(host, operation))) {
      await acceptMessage(host.storage, operation);

      return success(OperationReceipt.parse(operation.receipt));
    }
  }

  if (!operation && conversationId !== session.activeConversationId) return failure('conversation_not_active');

  if (!modelReady) return failure('model_unavailable');

  if (!operation) {
    const refused = await admissionRefusal(host, session, request);

    if (refused) return refused;
  }

  const input = await messageInput(host, request.text, request.attachments);

  if (!input) {
    // An admitted message whose upload is gone since must not stay unresolved and hold the session.
    if (operation) await withdrawMessage(host.storage, operation, previousMessage);

    return failure('attachment_not_found');
  }

  if (!operation) {
    operation = MessageOperation.parse({
      request,
      model: session.model,
      receipt: {
        operationId: request.operationId,
        sessionId: session.id,
        conversationId,
        runId: crypto.randomUUID(),
        action: 'submit_message',
        status: 'accepted',
        acceptedAt: new Date().toISOString(),
      },
      state: 'prepared',
      notice: await readNotice(host.storage),
      system,
    });
    await admitMessage(host.storage, operation);
  }

  try {
    // The write is idempotent by its own request ID, so a retry never delivers the notice twice.
    if (operation.notice) await writeNotice(host.harness, conversationId, request.operationId, operation.notice);

    await host.harness.submit(input.content, {
      session: conversationId,
      operationId: request.operationId,
      whenBusy: request.mode,
      entry: input.entry,
    });
  } catch (error) {
    if (error instanceof ConversationBusy) {
      await withdrawMessage(host.storage, operation, previousMessage);

      return failure('session_busy');
    }

    // Pi may have committed admission before its receipt was lost.
    return failure('message_unconfirmed');
  }

  await acceptMessage(host.storage, operation);

  return success(OperationReceipt.parse(operation.receipt));
}

/** The receipt of a message or cancellation in any conversation of the session. */
export async function messageReceipt(
  host: MessageHost,
  id: string,
): Promise<Result<OperationReceipt | CancelRunResponse>> {
  const operation = await readMessage(host.storage, id);

  if (!operation) {
    const cancellation = await readCancellation(host.storage, id);

    if (!cancellation) return failure('operation_not_found');

    if (cancellation.state !== 'accepted') return failure('cancel_unconfirmed');

    return success(CancelRunResponse.parse(cancellation.receipt));
  }

  if (operation.state !== 'accepted' && !(await nativeMessage(host, operation))) return failure('message_unconfirmed');

  return success(OperationReceipt.parse(operation.receipt));
}
