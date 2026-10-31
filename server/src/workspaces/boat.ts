import { BoatApi, Configuration, ResponseError } from '@boatdev/sdk';
import type { Session } from '@cloud-swe/protocol';
import type { SessionCreation } from '@cloud-swe/protocol/storage';
import { FileBytes, FileContent } from '@cloud-swe/protocol/tools';
import { Cause, Effect, Schedule } from 'effect';
import { z } from 'zod';

import type { Env } from '../env.ts';
import { isRefusal, WorkspaceError, workspaceError } from './errors.ts';

const BoatSandboxId = z.string().regex(/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);

// Only the error code is used to decide whether an idempotent create is still in progress.
export const BoatApiError = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string().min(1), message: z.string().optional() }),
});

// Only the fields consumed from Boat's documented sandbox.created envelope.
export const BoatSandboxCreated = z.object({
  ok: z.literal(true),
  type: z.literal('sandbox.created'),
  sandbox: z.object({ id: BoatSandboxId }),
});

// Recovery must see a complete result set before treating a missing sandbox as absent.
export const BoatSandboxList = z.object({
  ok: z.literal(true),
  type: z.literal('sandbox.list'),
  sandboxes: z.array(z.object({ id: BoatSandboxId, name: z.string().min(1) })).max(2),
  pageInfo: z.object({ hasMore: z.boolean() }),
});

// Only the fields consumed from Boat's documented sandbox.info envelope.
const BoatWorkspaceInfo = z.object({
  ok: z.literal(true),
  type: z.literal('sandbox.info'),
  sandbox: z.object({
    id: BoatSandboxId,
    state: z.enum([
      'init',
      'provisioning',
      'provisioned',
      'cloning',
      'ready',
      'idle',
      'running',
      'archiving',
      'archived',
      'error',
      'cancelled',
    ]),
    health: z.enum(['ok', 'degraded']).optional(),
    // Set once Boat deleted a stopped sandbox's saved disk (14 days after it stopped); resume then fails.
    dataExpiredAt: z.date().nullish(),
    access: z.enum(['owner', 'use', 'view']).optional(),
  }),
});

export const BoatFileInfo = z.object({
  ok: z.literal(true),
  type: z.literal('file.info'),
  name: z.string(),
  path: z.string().min(1),
  isDir: z.boolean(),
  isSymlink: z.boolean(),
  size: z.number().int().nonnegative(),
  modifiedAt: z.iso.datetime({ offset: true }),
});

export const BoatFileRead = z.object({
  ok: z.literal(true),
  type: z.literal('file.read'),
  success: z.literal(true),
  encoding: z.literal('utf8'),
  content: FileContent.shape.content,
});

export const BoatFileBytes = z.object({
  ok: z.literal(true),
  type: z.literal('file.read'),
  success: z.literal(true),
  encoding: z.literal('base64'),
  content: FileBytes.shape.content,
});

export const BoatFolderCreated = z.object({ ok: z.literal(true), type: z.literal('folder.created') });

export const BoatFileWritten = z.object({
  ok: z.literal(true),
  type: z.literal('file.written'),
  success: z.literal(true),
});

export const BoatCommandDispatched = z.object({
  ok: z.literal(true),
  type: z.literal('command.started'),
  success: z.literal(true),
});

type BoatEnv = Pick<Env, 'BOAT_API_KEY'>;

export function boatClient(env: BoatEnv): BoatApi {
  if (!env.BOAT_API_KEY) throw new WorkspaceError({ reason: 'configuration' });

  // Use the Worker's fetch rather than the SDK's Node HTTP/2 transport.
  return new BoatApi(new Configuration({ accessToken: env.BOAT_API_KEY, fetchApi: fetch }));
}

function isInProgress(failure: Cause.UnknownError | Cause.TimeoutError): Effect.Effect<boolean> {
  const error = failure.cause;

  if (!(error instanceof ResponseError) || error.response.status !== 409) return Effect.succeed(false);

  return Effect.tryPromise(() => error.response.json()).pipe(
    Effect.map((body) => {
      const parsed = BoatApiError.safeParse(body);

      return parsed.success && parsed.data.error.code === 'idempotency_in_progress';
    }),
    Effect.orElseSucceed(() => false),
  );
}

export function createBoatSandbox(env: BoatEnv, creation: SessionCreation): Effect.Effect<string, WorkspaceError> {
  return Effect.tryPromise((signal) =>
    boatClient(env).create(
      {
        // Boat returns the same sandbox for a retried operation instead of a second billable one.
        idempotencyKey: creation.request.operationId,
        createSandboxRequest: {
          environment: creation.request.environment,
          name: `cloud-swe-${creation.workspaceId}`,
          type: 'default',
        },
      },
      { signal },
    ),
  ).pipe(
    Effect.timeout('30 seconds'),
    Effect.retry({ times: 9, schedule: Schedule.spaced('1 second'), while: isInProgress }),
    Effect.timeout('2 minutes'),
    Effect.mapError((failure) =>
      // A 4xx means Boat rejected the create, so no sandbox exists and the caller may release its slot.
      failure.cause instanceof ResponseError && isRefusal(failure.cause.response.status)
        ? new WorkspaceError({ reason: 'refused' })
        : workspaceError(failure),
    ),
    Effect.flatMap((created) =>
      Effect.try({
        try: () => BoatSandboxCreated.parse(created).sandbox.id,
        catch: () => new WorkspaceError({ reason: 'invalid_response' }),
      }),
    ),
  );
}

export async function findBoatSandbox(
  env: BoatEnv,
  creation: SessionCreation,
  signal: AbortSignal,
): Promise<string | null> {
  const name = `cloud-swe-${creation.workspaceId}`;
  const parsed = BoatSandboxList.safeParse(await boatClient(env).sandboxes({ namePrefix: name, limit: 2 }, { signal }));

  if (!parsed.success) throw new WorkspaceError({ reason: 'invalid_response' });

  // Never guess which sandbox belongs to an intent, or treat a truncated result as absence.
  if (parsed.data.pageInfo.hasMore) throw new WorkspaceError({ reason: 'uncertain' });
  const matches = parsed.data.sandboxes.filter((sandbox) => sandbox.name === name);

  if (matches.length > 1) throw new WorkspaceError({ reason: 'uncertain' });

  return matches[0]?.id ?? null;
}

async function errorCode(error: ResponseError): Promise<string | undefined> {
  const body = BoatApiError.safeParse(await error.response.json().catch(() => null));

  return body.success ? body.data.error.code : undefined;
}

/** Sets the auto-stop deadline to now + ttlSeconds. Boat's timer ignores activity, so a run calls this repeatedly. */
export async function renewBoatSandbox(env: BoatEnv, sandboxId: string, ttlSeconds: number, signal: AbortSignal) {
  await boatClient(env).update({ sandboxId, updateSandboxRequest: { ttlSeconds } }, { signal });
}

/** Resumes a stopped sandbox with a fresh auto-stop deadline. An expired or deleted disk cannot resume. */
export async function resumeBoatSandbox(env: BoatEnv, sandboxId: string, ttlSeconds: number, signal: AbortSignal) {
  try {
    await boatClient(env).resume({ sandboxId, resumeRequest: { ttlSeconds } }, { signal });
  } catch (error) {
    if (error instanceof ResponseError && (await errorCode(error)) === 'snapshot_data_expired')
      throw new WorkspaceError({ reason: 'expired' });

    if (error instanceof ResponseError && error.response.status === 404)
      throw new WorkspaceError({ reason: 'expired' });
    throw error;
  }
}

/** Irreversible. Boat requires the sandbox ID as a confirmation header; an already-gone sandbox is a success. */
export async function deleteBoatSandbox(env: BoatEnv, sandboxId: string, signal: AbortSignal) {
  try {
    await boatClient(env).deleteSandbox({ sandboxId, xAsciiConfirmDelete: sandboxId }, { signal });
  } catch (error) {
    if (!(error instanceof ResponseError && error.response.status === 404)) throw error;
  }
}

export async function inspectBoatSandbox(
  env: BoatEnv,
  sandboxId: string,
  signal: AbortSignal,
): Promise<Session['workspace']['state']> {
  let info: unknown;

  try {
    info = await boatClient(env).get({ sandboxId }, { signal });
  } catch (error) {
    // Boat answers 404 once a sandbox is deleted.
    if (error instanceof ResponseError && error.response.status === 404) return 'deleted';
    throw error;
  }

  const parsed = BoatWorkspaceInfo.safeParse(info);

  if (!parsed.success) throw new WorkspaceError({ reason: 'invalid_response' });
  const { sandbox } = parsed.data;

  if (sandbox.id !== sandboxId || sandbox.access === 'view') {
    throw new WorkspaceError({ reason: 'invalid_response' });
  }

  if (sandbox.health === 'degraded') return 'unreachable';

  switch (sandbox.state) {
    case 'ready':
    case 'idle':
    case 'running':
      return 'running';
    case 'init':
    case 'provisioning':
    case 'provisioned':
    case 'cloning':
      return 'starting';
    case 'archiving':
    case 'archived':
      return sandbox.dataExpiredAt ? 'deleted' : 'stopped';
    // These never run again, so they are as good as deleted: the slot frees and the next message gets a replacement.
    case 'error':
    case 'cancelled':
      return 'deleted';
    default: {
      const exhaustive: never = sandbox.state;

      return exhaustive;
    }
  }
}
