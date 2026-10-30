import { CancelRunRequest, OperationReceipt, Session } from '@cloud-swe/protocol';
import { CancelOperation } from '@cloud-swe/protocol/storage';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import { LiveDoc, type SubmissionId, type TaskId } from '@earendil-works/pi-durable';
import type { PiHarness } from 'agents/harness/pi';

import { apiError } from '../http';
import { pendingMessages } from './message-state';

/** Capture the cancellation scope under the Thread's short admission gate. */
export async function admitCancellation(
  storage: DurableObjectStorage,
  harness: PiHarness,
  session: Session,
  raw: CancelRunRequest,
): Promise<CancelOperation | Response> {
  const request = CancelRunRequest.parse(raw);
  const key = `cancel:${request.operationId}`;

  if ((await storage.get(`message:${request.operationId}`)) !== undefined) {
    return apiError(409, 'operation_conflict', 'Operation ID already used for a different action');
  }

  const saved = await storage.get<unknown>(key);

  if (saved !== undefined) {
    const operation = CancelOperation.parse(saved);

    if (JSON.stringify(operation.request) !== JSON.stringify(request)) {
      return apiError(409, 'operation_conflict', 'Operation ID already used for a different request');
    }

    return operation.state === 'accepted'
      ? Response.json(OperationReceipt.parse(operation.receipt), { status: 202 })
      : operation;
  }

  if (session.run.kind === 'uncertain') return apiError(409, 'busy', 'Session has unresolved work');
  const pending = await pendingMessages({ storage, harness });
  const target = pending.find(({ operation }) => operation.receipt.runId === request.runId);

  if (!target) return apiError(409, 'run_conflict', 'Run is not active or queued');

  const scope = target.status === 'queued' ? [target] : pending;

  const operation = CancelOperation.parse({
    request,
    messageOperationIds: scope.map(({ operation }) => operation.request.operationId),
    receipt: {
      operationId: request.operationId,
      sessionId: session.id,
      runId: request.runId,
      action: 'cancel_run',
      status: 'accepted',
      acceptedAt: new Date().toISOString(),
    },
    state: 'prepared',
  });

  await storage.put({ [key]: operation, currentCancellation: request.operationId });

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
): Promise<Response> {
  try {
    // Withdraw queued inputs before aborting the active task, so no captured follow-up is stranded.
    for (const id of [...operation.messageOperationIds].reverse()) await abortInput(harness, id);
  } catch {
    return apiError(503, 'unavailable', 'Cancellation is unresolved; retry the original operation');
  }

  await storage.put(`cancel:${operation.request.operationId}`, { ...operation, state: 'accepted' });

  return Response.json(OperationReceipt.parse(operation.receipt), { status: 202 });
}
