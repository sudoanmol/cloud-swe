import { Cause, Context as Services, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { Context } from "@temporalio/activity";
import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import type { ThreadStore } from "@cloud-swe/db/thread-contracts";
import type { Pool, PoolClient } from "pg";
import type { Logger } from "pino";
import type { ExecutionCoordinator } from "./execution-coordinator.js";
import { publicFailureForCode } from "@cloud-swe/db/public-failure";
import { failureIdentities } from "./failure.js";

export class RunnerServices extends Services.Service<
  RunnerServices,
  {
    store: ThreadStore;
    pool: Pool;
    coordinator: ExecutionCoordinator;
  }
>()("cloud-swe/RunnerServices") {}

export function createActivityRuntime(services: RunnerServices["Service"]) {
  return ManagedRuntime.make(Layer.succeed(RunnerServices, services));
}

export type ActivityRuntime = ReturnType<typeof createActivityRuntime>;

export class ActivityResourceError extends Error {
  readonly _tag = "ActivityResourceError";
  readonly code = "ACTIVITY_RESOURCE_FAILED";

  constructor() {
    super("An activity resource failed");
  }
}

export type WorkspaceLockOptions = {
  pool: Pick<Pool, "connect">;
  threadId: string;
  logger: Logger;
  cleanupMs?: number;
};

/** Owns the connection until protected work settles, including interruption. */
export const workspaceLock = Effect.fnUntraced(function* <T>(
  options: WorkspaceLockOptions,
  work: (signal: AbortSignal) => Promise<T>,
) {
  const { pool, threadId, logger, cleanupMs = 10_000 } = options;
  const failure = new AbortController();
  let uncertain = false;

  const failConnection = () => {
    uncertain = true;
    failure.abort();
  };

  const connectionFailure = Effect.callback<never, ActivityResourceError>((resume) => {
    const fail = () => resume(Effect.fail(new ActivityResourceError()));
    failure.signal.addEventListener("abort", fail, { once: true });

    if (failure.signal.aborted) fail();

    return Effect.sync(() => failure.signal.removeEventListener("abort", fail));
  });

  const protectedWork = Effect.scoped(
    Effect.gen(function* () {
      // Pool acquisition remains interruptible. A late connection is destroyed.
      const client = yield* Effect.acquireRelease(
        Effect.callback<PoolClient, ActivityResourceError>((resume, signal) => {
          void pool.connect().then(
            (connected) => {
              if (signal.aborted) connected.release(true);
              else {
                connected.on("error", failConnection);
                resume(Effect.succeed(connected));
              }
            },
            () => resume(Effect.fail(new ActivityResourceError())),
          );
        }),
        (connected) =>
          Effect.sync(() => {
            connected.release(uncertain);
            connected.off("error", failConnection);
          }),
        { interruptible: true },
      );

      let locked = false;
      let lockKey = "";
      // Keep the error listener through unlock and release. Any ambiguity destroys the client.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (!locked || uncertain) return;

          const unlocked = yield* Effect.tryPromise({
            try: () =>
              client.query<{ unlocked: boolean }>({
                text: "select pg_advisory_unlock(hashtextextended($1, 0)) as unlocked",
                values: [lockKey],
              }),
            catch: () => new ActivityResourceError(),
          }).pipe(
            Effect.match({
              onFailure: () => false,
              onSuccess: (result) => result.rows[0]?.unlocked === true,
            }),
          );

          if (!unlocked) {
            uncertain = true;
            logger.warn({ threadId }, "Workspace lock release failed; connection destroyed");
          }
        }),
      );

      const owner = yield* Effect.tryPromise({
        try: () =>
          client.query<{ user_id: string }>({
            text: "select user_id from thread where id = $1",
            values: [threadId],
          }),
        catch: () => {
          uncertain = true;

          return new ActivityResourceError();
        },
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            uncertain = true;
          }),
        ),
      );

      if (owner.rows[0]) {
        lockKey = `workspace-thread:${threadId}`;

        while (!locked) {
          // Interruption during a query makes its lock outcome ambiguous.
          const result = yield* Effect.tryPromise({
            try: () =>
              client.query<{ locked: boolean }>({
                text: "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
                values: [lockKey],
              }),
            catch: () => {
              uncertain = true;

              return new ActivityResourceError();
            },
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                uncertain = true;
              }),
            ),
          );

          locked = result.rows[0]?.locked === true;

          if (!locked) yield* Effect.sleep(100);
        }
      }

      const controller = new AbortController();

      const pending = yield* Effect.acquireRelease(
        Effect.sync(() => ({
          promise: Promise.resolve().then(() => {
            if (controller.signal.aborted) {
              throw (
                controller.signal.reason ?? new DOMException("Activity cancelled", "AbortError")
              );
            }

            return work(controller.signal);
          }),
        })),
        ({ promise }) =>
          Effect.gen(function* () {
            controller.abort();

            const settled = yield* Effect.promise(() =>
              promise.then(
                () => true,
                () => true,
              ),
            ).pipe(Effect.timeoutOption(cleanupMs));

            if (settled._tag === "None") {
              uncertain = true;
              logger.warn({ threadId }, "Activity cleanup timed out; connection destroyed");
            }
          }),
      );

      return yield* Effect.tryPromise({ try: () => pending.promise, catch: (error) => error });
    }),
  );

  return yield* Effect.raceFirst(protectedWork, connectionFailure);
});

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the Temporal boundary for arbitrary SDK and Effect failures.
export function temporalFailure(error: unknown, cancelled: boolean): Error {
  if (cancelled || error instanceof CancelledFailure) return new CancelledFailure("Run cancelled");
  const identity = failureIdentities(error).find(({ code, type }) => code || type);
  const failure = publicFailureForCode(identity?.type ?? identity?.code ?? "ACTIVITY_FAILED");
  const type = failure.code;

  return ApplicationFailure.create({
    message: failure.message,
    type,
    nonRetryable:
      error instanceof ApplicationFailure
        ? (error.nonRetryable ?? false)
        : ["CHECKPOINT_OWNERSHIP_LOST", "INVALID_CHECKPOINT", "CHECKPOINT_TOO_LARGE"].includes(
            type,
          ),
  });
}

export function withActivityHeartbeat<T, E, R>(program: Effect.Effect<T, E, R>, pulse: () => void) {
  return Effect.raceFirst(
    program,
    Effect.forever(
      Effect.gen(function* () {
        yield* Effect.try({ try: pulse, catch: () => new ActivityResourceError() });
        yield* Effect.sleep(1_000);
      }),
    ),
  );
}

export async function runActivity<T>(
  runtime: ActivityRuntime,
  program: Effect.Effect<T, unknown, RunnerServices>,
): Promise<T> {
  const context = Context.current();

  const exit = await runtime.runPromiseExit(
    withActivityHeartbeat(program, () => context.heartbeat()),
    { signal: context.cancellationSignal },
  );

  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
