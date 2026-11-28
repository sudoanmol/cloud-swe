/**
 * Path: server/src/sessions/cancellation.ts
 * Used by: server/src/sessions/thread.ts.
 * Purpose: Admits and executes a cancellation: freezes the pending-input scope, aborts the bound Pi task, returns queued user text for the client to restore and keeps withdrawn server-written follow-ups as notices for the model.
 */

import { type CancelRunRequest, CancelRunResponse, type Session } from '@cloud-swe/protocol';
import { CancelOperation } from '@cloud-swe/protocol/storage';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import { LiveDoc, type SubmissionId, type TaskId } from '@earendil-works/pi-durable';
import type { PiHarness } from 'agents/harness/pi';

import { failure, logFault, type Result, success } from '../errors.ts';
import {
  admitCancellationIntent,
  hasMessage,
  hasRewind,
  readCancellation,
  readMessage,
  writeCancellation,
} from '../thread-store.ts';
import { sameRequest } from './idempotency.ts';
import { type MessageHost, nativeMessage, pendingMessages } from './messages.ts';
import { writeNotice } from './notice.ts';
import { requireConversation } from './pi.ts';

type PendingMessage = Awaited<ReturnType<typeof pendingMessages>>[number];

/** A queued target is withdrawn alone; a placed one takes every pending input with it. */
export function cancellationScope(target: PendingMessage, pending: readonly PendingMessage[]): PendingMessage[] {
  if (target.status === 'queued') return [target];

  // An uncertain target settled natively, so it is not pending, yet it must still be interrupted.
  return pending.includes(target) ? [...pending] : [target, ...pending];
}

/**
 * What admitting a cancellation leads to: the receipt of one already accepted, or the intent to execute (new, or a
 * retry of one that did not finish).
 */
type Admitted = { kind: 'accepted'; receipt: CancelRunResponse } | { kind: 'execute'; operation: CancelOperation };

/** A new cancellation targets the session's active conversation; a retry is the same only in the one it was admitted to. */
export async function admitCancellation(
  host: MessageHost,
  session: Session,
  conversationId: string,
  request: CancelRunRequest,
): Promise<Result<Admitted>> {
  const { storage } = host;

  if ((await hasMessage(storage, request.operationId)) || (await hasRewind(storage, request.operationId)))
    return failure('operation_conflict');

  const saved = await readCancellation(storage, request.operationId);

  if (saved) {
    if (
      saved.receipt.conversationId !== conversationId ||
      !sameRequest(saved.request, CancelOperation.shape.request.parse(request))
    )
      return failure('operation_conflict');

    return success<Admitted>(
      saved.state === 'accepted'
        ? { kind: 'accepted', receipt: CancelRunResponse.parse(saved.receipt) }
        : { kind: 'execute', operation: saved },
    );
  }

  if (conversationId !== session.activeConversationId) return failure('conversation_not_active');

  const pending = await pendingMessages(host, conversationId);
  let target = pending.find(({ operation }) => operation.receipt.runId === request.runId);

  if (!target && session.run.kind === 'uncertain' && session.run.runId === request.runId) {
    const operation = await readMessage(storage, session.run.operationId);

    // A settled native input may still own uncertain remote work. Never cancel unconfirmed admission.
    if (operation && (await nativeMessage(host, operation))) {
      target = { operation, status: 'running' };
    }
  }

  if (!target) return failure('run_not_active');

  const scope = cancellationScope(target, pending);
  const queued = scope.filter(({ status }) => status === 'queued').map(({ operation }) => operation);

  const operation = CancelOperation.parse({
    request,
    messageOperationIds: scope.map(({ operation }) => operation.request.operationId),
    withdrawnSystemIds: queued.filter(({ system }) => system).map(({ request }) => request.operationId),
    receipt: {
      operationId: request.operationId,
      sessionId: session.id,
      conversationId,
      runId: request.runId,
      // Only what the user typed goes back to the editor; an answer or a request's outcome is not theirs to resend.
      restoredMessages: queued
        .filter(({ system }) => !system)
        .map((operation) => ({
          operationId: operation.request.operationId,
          mode: operation.request.mode,
          text: operation.request.text,
          attachments: operation.request.attachments,
        })),
      action: 'cancel_run',
      status: 'accepted',
      acceptedAt: new Date().toISOString(),
    },
    state: 'prepared',
  });

  await admitCancellationIntent(storage, operation);

  return success<Admitted>({ kind: 'execute', operation });
}

type AbortTarget = { kind: 'settled' } | { kind: 'queued'; id: SubmissionId } | { kind: 'running'; id: TaskId };

/** Re-resolve task handovers, but never abort whichever conversation happens to be current later. */
async function abortInput(harness: PiHarness, conversationId: string, operationId: string): Promise<void> {
  const pi = await harness.pi();
  const conversation = await requireConversation(harness, conversationId);

  for (let transition = 0; transition < 100; transition++) {
    const target = await pi.commit<AbortTarget>(async (tx) => {
      const input = await tx.submissionByRequest(conversation.id, operationId);

      if (!input || input.status === 'done' || input.status === 'unanswered') return { kind: 'settled' };

      if (input.status === 'queued') return { kind: 'queued', id: input.id };
      const live = await tx.doc(LiveDoc, conversation.id);

      if (!live.run?.inputs.includes(input.id)) throw new Error('Missing native run binding');

      return { kind: 'running', id: live.run.taskId };
    }, BG);

    if (target.kind === 'settled') return;

    if (target.kind === 'queued') {
      if ((await pi.abortSubmission(target.id, BG, conversation.id)) !== 'already_placed') return;
    } else {
      await pi.abortTask(target.id, BG);
      await pi.waitForTask(target.id, BG);
    }
  }

  throw new Error('Cancellation did not settle');
}

/**
 * No DO admission gate while joining model/tool interruption: I/O must be allowed to finish. `interrupt` stops the
 * remote commands; it is passed in because importing the sandbox runtime here would keep this module from loading in
 * plain Node, where cancellationScope is tested.
 */
export async function executeCancellation(
  host: MessageHost,
  operation: CancelOperation,
  interrupt: (messageIds: readonly string[]) => Promise<boolean>,
): Promise<Result<CancelRunResponse>> {
  const { storage, harness } = host;
  const { conversationId } = operation.receipt;
  let remoteStopped = false;

  try {
    // Withdraw queued inputs before aborting the active task, so no captured follow-up is stranded.
    for (const id of [...operation.messageOperationIds].reverse()) await abortInput(harness, conversationId, id);
    remoteStopped = await interrupt(operation.messageOperationIds);
  } catch (error) {
    if (error instanceof Error) logFault('Cancellation failed', error);

    return failure('cancel_unconfirmed');
  }

  if (!remoteStopped) return failure('cancel_unconfirmed');

  // The agent still needs a withdrawn answer or outcome, but must not start again for it. A passive write
  // keeps it in the conversation for the next run.
  for (const id of operation.withdrawnSystemIds) {
    const withdrawn = await readMessage(storage, id);

    if (withdrawn) await writeNotice(harness, conversationId, `withdrawn:${id}`, withdrawn.request.text);
  }

  await writeCancellation(storage, { ...operation, state: 'accepted' });

  return success(CancelRunResponse.parse(operation.receipt));
}
