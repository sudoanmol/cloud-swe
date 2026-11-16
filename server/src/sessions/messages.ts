/**
 * Path: server/src/sessions/messages.ts
 * Used by: server/src/sessions/{cancellation,thread}.ts.
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

import { apiError } from '../errors.ts';
import {
  acceptMessage,
  admitMessage,
  currentCancellation,
  currentMessageId,
  hasCancellation,
  readCancellation,
  readMessage,
  readNotice,
  withdrawMessage,
} from '../thread-store.ts';
import { failureFromDetail } from './failures.ts';
import { sameRequest } from './idempotency.ts';
import { isNotice, writeNotice } from './notice.ts';
import { rootConversation } from './pi.ts';

export type MessageHost = { storage: DurableObjectStorage; harness: PiHarness };

export async function nativeMessage(host: MessageHost, operationId: string) {
  const root = await rootConversation(host.harness);

  return (await host.harness.storage()).submissionByRequest(root.id, operationId, BG);
}

export async function pendingMessages(host: MessageHost) {
  return Promise.all(
    // A queued notice write shares Pi's request namespace but is not a message.
    (await host.harness.pending())
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
  const current = await currentMessageId(host.storage);

  if (current === undefined) return { run: { kind: 'idle' }, pending: [] };
  const last = await readMessage(host.storage, current);

  if (!last) throw new Error('Missing current message intent');
  const native = await nativeMessage(host, last.request.operationId);
  const messages = await pendingMessages(host);

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
    const cancellation = await currentCancellation(host.storage);

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

/** Called under the Thread's admission gate; the client connection does not own Pi's run. */
export async function submitMessage(
  host: MessageHost,
  session: Session,
  request: SubmitMessageRequest,
  modelReady: boolean,
  system?: true,
): Promise<Response> {
  if (await hasCancellation(host.storage, request.operationId)) {
    return apiError('operation_conflict');
  }

  const previousMessage = await currentMessageId(host.storage);
  let operation = await readMessage(host.storage, request.operationId);

  if (operation) {
    if (
      !sameRequest(operation.request, MessageOperation.shape.request.parse(request)) ||
      !sameRequest(operation.model, MessageOperation.shape.model.parse(session.model))
    ) {
      return apiError('operation_conflict');
    }

    // A crash may leave the application receipt pending after Pi already admitted it.
    if (operation.state === 'accepted' || (await nativeMessage(host, request.operationId))) {
      await acceptMessage(host.storage, operation);

      return Response.json(OperationReceipt.parse(operation.receipt), { status: 202 });
    }
  }

  if (!modelReady) {
    return apiError('model_unavailable');
  }

  if (!operation) {
    if (session.pending.length >= PENDING_INPUTS_LIMIT) return apiError('input_queue_full');

    if (session.run.kind === 'uncertain' || session.run.kind === 'cancelling') return apiError('session_settling');

    if (
      request.mode === 'reject' &&
      (session.run.kind === 'running' || session.run.kind === 'retrying' || (await host.harness.session().busy()))
    ) {
      return apiError('session_busy');
    }

    operation = MessageOperation.parse({
      request,
      model: session.model,
      receipt: {
        operationId: request.operationId,
        sessionId: session.id,
        conversationId: session.activeConversationId,
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
    if (operation.notice) await writeNotice(host.harness, request.operationId, operation.notice);
    await host.harness.submit(request.text, { operationId: request.operationId, whenBusy: request.mode });
  } catch (error) {
    if (error instanceof ConversationBusy) {
      await withdrawMessage(host.storage, request.operationId, previousMessage);

      return apiError('session_busy');
    }

    // Pi may have committed admission before its receipt was lost.
    return apiError('message_unconfirmed');
  }

  await acceptMessage(host.storage, operation);

  return Response.json(OperationReceipt.parse(operation.receipt), { status: 202 });
}

export async function messageReceipt(host: MessageHost, id: string): Promise<Response> {
  const operation = await readMessage(host.storage, id);

  if (!operation) {
    const cancellation = await readCancellation(host.storage, id);

    if (!cancellation) return apiError('operation_not_found');

    if (cancellation.state !== 'accepted') {
      return apiError('cancel_unconfirmed');
    }

    return Response.json(CancelRunResponse.parse(cancellation.receipt));
  }

  if (operation.state !== 'accepted' && !(await nativeMessage(host, operation.request.operationId))) {
    return apiError('message_unconfirmed');
  }

  return Response.json(OperationReceipt.parse(operation.receipt));
}
