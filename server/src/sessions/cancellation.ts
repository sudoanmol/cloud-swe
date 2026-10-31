import { CancelRunRequest, CancelRunResponse, Session } from '@cloud-swe/protocol';
import { CancelOperation } from '@cloud-swe/protocol/storage';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import { LiveDoc, type SubmissionId, type TaskId } from '@earendil-works/pi-durable';
import type { PiHarness } from 'agents/harness/pi';

import { apiError } from '../errors.ts';
import { nativeMessage, pendingMessages } from './messages.ts';
import {
  admitCancellationIntent,
  hasMessage,
  readCancellation,
  readMessage,
  writeCancellation,
} from './thread-store.ts';

type PendingMessage = Awaited<ReturnType<typeof pendingMessages>>[number];

/** A queued target is withdrawn alone; a placed one takes every pending input with it. */
export function cancellationScope(target: PendingMessage, pending: readonly PendingMessage[]): PendingMessage[] {
  if (target.status === 'queued') return [target];

  // An uncertain target settled natively, so it is not pending, yet it must still be interrupted.
  return pending.includes(target) ? [...pending] : [target, ...pending];
}

/** Capture the cancellation scope under the Thread's short admission gate. */
export async function admitCancellation(
  storage: DurableObjectStorage,
  harness: PiHarness,
  session: Session,
  raw: CancelRunRequest,
): Promise<CancelOperation | Response> {
  const request = CancelRunRequest.parse(raw);

  if (await hasMessage(storage, request.operationId)) {
    return apiError('operation_conflict');
  }

  const saved = await readCancellation(storage, request.operationId);

  if (saved) {
    if (JSON.stringify(saved.request) !== JSON.stringify(request)) {
      return apiError('operation_conflict');
    }

    return saved.state === 'accepted' ? Response.json(CancelRunResponse.parse(saved.receipt), { status: 202 }) : saved;
  }

  const pending = await pendingMessages({ storage, harness });
  let target = pending.find(({ operation }) => operation.receipt.runId === request.runId);

  if (!target && session.run.kind === 'uncertain' && session.run.runId === request.runId) {
    const operation = await readMessage(storage, session.run.operationId);

    // A settled native input may still own uncertain remote work. Never cancel unconfirmed admission.
    if (operation && (await nativeMessage({ storage, harness }, operation.request.operationId))) {
      target = { operation, status: 'running' };
    }
  }

  if (!target) return apiError('run_not_active');

  const scope = cancellationScope(target, pending);

  const operation = CancelOperation.parse({
    request,
    messageOperationIds: scope.map(({ operation }) => operation.request.operationId),
    receipt: {
      operationId: request.operationId,
      sessionId: session.id,
      runId: request.runId,
      restoredMessages: scope
        .filter(({ status }) => status === 'queued')
        .map(({ operation }) => ({
          operationId: operation.request.operationId,
          mode: operation.request.mode,
          text: operation.request.text,
        })),
      action: 'cancel_run',
      status: 'accepted',
      acceptedAt: new Date().toISOString(),
    },
    state: 'prepared',
  });

  await admitCancellationIntent(storage, operation);

  return operation;
}

type AbortTarget = { kind: 'settled' } | { kind: 'queued'; id: SubmissionId } | { kind: 'running'; id: TaskId };

/** Re-resolve task handovers, but never abort whichever conversation happens to be current later. */
async function abortInput(harness: PiHarness, operationId: string): Promise<void> {
  const pi = await harness.pi();
  const root = await pi.root(BG);

  for (let transition = 0; transition < 100; transition++) {
    const target = await pi.commit<AbortTarget>(async (tx) => {
      const input = await tx.submissionByRequest(root.id, operationId);

      if (!input || input.status === 'done' || input.status === 'unanswered') return { kind: 'settled' };

      if (input.status === 'queued') return { kind: 'queued', id: input.id };
      const live = await tx.doc(LiveDoc, root.id);

      if (!live.run?.inputs.includes(input.id)) throw new Error('Missing native run binding');

      return { kind: 'running', id: live.run.taskId };
    }, BG);

    if (target.kind === 'settled') return;

    if (target.kind === 'queued') {
      if ((await pi.abortSubmission(target.id, BG, root.id)) !== 'already_placed') return;
    } else {
      await pi.abortTask(target.id, BG);
      await pi.waitForTask(target.id, BG);
    }
  }

  throw new Error('Cancellation did not settle');
}

/** No DO admission gate while joining model/tool interruption: I/O must be allowed to finish. */
export async function executeCancellation(
  storage: DurableObjectStorage,
  harness: PiHarness,
  operation: CancelOperation,
  interrupt: (messageIds: readonly string[]) => Promise<boolean>,
): Promise<Response> {
  let remoteStopped = false;

  try {
    // Withdraw queued inputs before aborting the active task, so no captured follow-up is stranded.
    for (const id of [...operation.messageOperationIds].reverse()) await abortInput(harness, id);
    remoteStopped = await interrupt(operation.messageOperationIds);
  } catch {
    return apiError('cancel_unconfirmed');
  }

  if (!remoteStopped) return apiError('cancel_unconfirmed');

  await writeCancellation(storage, { ...operation, state: 'accepted' });

  return Response.json(CancelRunResponse.parse(operation.receipt), { status: 202 });
}
