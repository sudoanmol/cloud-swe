import { Deferred, Effect, Fiber, Queue, Stream } from "effect";
import type { Done } from "effect/Cause";

// oxlint-disable anti-slop/no-unknown-parameters -- Persistence failures cross an arbitrary Promise boundary and are retained for precedence.
export type Awaitable<T> = T | PromiseLike<T>;

export type PiWriterItemKind = "event" | "checkpoint" | "barrier";

export interface PiWriterOptions {
  /** Maximum number of admitted items, including the item being written. */
  itemLimit?: number;
  /** Maximum bytes retained by admitted items, including the active write. */
  byteLimit?: number;
  cleanupTimeoutMs?: number;
  onFailure?: (error: unknown) => Awaitable<void>;
}

export interface PiWriterCompletionOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface PiWriterEnqueueOptions {
  kind?: Exclude<PiWriterItemKind, "barrier">;
  /** Size of the immutable payload captured by the caller. */
  sizeBytes?: number;
}

export class PiPersistenceOverflowError extends Error {
  readonly code = "PERSISTENCE_OVERFLOW" as const;
  readonly itemLimit: number;
  readonly byteLimit: number;

  constructor(itemLimit: number, byteLimit: number) {
    super("Pi persistence admission limit exceeded");
    this.name = "PiPersistenceOverflowError";
    this.itemLimit = itemLimit;
    this.byteLimit = byteLimit;
  }
}

export class PiWriterClosedError extends Error {
  constructor() {
    super("Pi persistence writer is closed");
    this.name = "PiWriterClosedError";
  }
}

export class PiPersistenceCleanupError extends Error {
  readonly code = "PERSISTENCE_CLEANUP_FAILED" as const;

  constructor(reason: "cancelled" | "timeout") {
    super(`Pi persistence cleanup ${reason}`);
    this.name = "PiPersistenceCleanupError";
  }
}

interface PiWriterItem {
  readonly kind: PiWriterItemKind;
  readonly sizeBytes: number;
  readonly write: () => Awaitable<void>;
  readonly acknowledgement: Deferred.Deferred<void, unknown>;
}

interface PiWriterFailure {
  readonly error: unknown;
}

type PiWriterFailureMode = "overflow" | "producer" | "persistence" | "cleanup";

const defaultItemLimit = 1_024;

const defaultByteLimit = 16 * 1024 * 1024;

const defaultCleanupTimeoutMs = 10_000;

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const limit = value ?? fallback;

  if (!Number.isInteger(limit) || limit <= 0) throw new Error(`${name} must be a positive integer`);

  return limit;
}

/**
 * One FIFO persistence consumer for a Pi attempt.
 *
 * The public admission methods are synchronous at the queue boundary. They
 * never create a pending offer fiber, which is necessary because Pi's event
 * subscription cannot await backpressure. The Deferred attached to each item
 * only represents commit acknowledgement for callers that need it.
 */
export class PiPersistenceWriter {
  private readonly queue: Queue.Queue<PiWriterItem, Done>;
  private readonly itemLimit: number;
  private readonly byteLimit: number;
  private readonly cleanupTimeoutMs: number;
  private readonly onFailure: ((error: unknown) => Awaitable<void>) | undefined;
  private readonly pending = new Set<PiWriterItem>();
  private readonly consumer: Fiber.Fiber<void, never>;
  private abortCompletion: Promise<void> = Promise.resolve();
  private firstFailure: PiWriterFailure | undefined;
  private failureMode: PiWriterFailureMode | undefined;
  private admittedItems = 0;
  private retainedBytes = 0;
  private accepting = true;

  constructor(options: PiWriterOptions = {}) {
    this.itemLimit = positiveLimit(options.itemLimit, defaultItemLimit, "itemLimit");
    this.byteLimit = positiveLimit(options.byteLimit, defaultByteLimit, "byteLimit");
    this.cleanupTimeoutMs = positiveLimit(
      options.cleanupTimeoutMs,
      defaultCleanupTimeoutMs,
      "cleanupTimeoutMs",
    );
    this.onFailure = options.onFailure;
    this.queue = Effect.runSync(Queue.bounded<PiWriterItem, Done>(this.itemLimit));

    this.consumer = Effect.runFork(this.consume());
  }

  get failure(): PiWriterFailure | undefined {
    return this.firstFailure;
  }

  get failed(): boolean {
    return this.firstFailure !== undefined;
  }

  get retainedItemCount(): number {
    return this.admittedItems;
  }

  get retainedPayloadBytes(): number {
    return this.retainedBytes;
  }

  /** Latch a producer-side failure (for example, checkpoint validation). */
  fail(error: unknown): void {
    this.recordFailure(error, "producer");
  }

  /**
   * Admit an event or checkpoint synchronously and return its commit ack.
   * `operation` must close over an immutable snapshot captured before calling
   * this method.
   */
  enqueue(operation: () => Awaitable<void>, options: PiWriterEnqueueOptions = {}): Promise<void> {
    return this.admit({
      kind: options.kind ?? "event",
      sizeBytes: options.sizeBytes ?? 0,
      write: operation,
    });
  }

  /**
   * Check admission synchronously before a caller captures an expensive
   * immutable snapshot. JavaScript producers cannot interleave between this
   * check and the following enqueue, so the check and capture stay race-free.
   */
  preflight(sizeBytes: number): void {
    if (!this.accepting || this.firstFailure)
      throw this.firstFailure?.error ?? new PiWriterClosedError();

    this.assertAdmissible(sizeBytes);
  }

  /** Add a FIFO barrier that acknowledges all preceding accepted items. */
  flush(): Promise<void> {
    return this.admit({ kind: "barrier", sizeBytes: 0, write: () => undefined });
  }

  /** Stop admission, drain accepted items, then dispose the queue consumer. */
  async complete(options: PiWriterCompletionOptions = {}): Promise<void> {
    this.close();

    try {
      await this.awaitConsumer(options);
    } catch (error) {
      const cleanup =
        error instanceof PiPersistenceCleanupError
          ? error
          : new PiPersistenceCleanupError("cancelled");

      const priorFailure = this.firstFailure?.error;
      this.recordFailure(cleanup, "cleanup");
      Effect.runFork(Fiber.interrupt(this.consumer));
      throw priorFailure ?? cleanup;
    }

    try {
      await this.awaitAbortCompletion(options);
    } catch (error) {
      this.recordFailure(error, "cleanup");
      throw this.firstFailure?.error ?? error;
    }

    if (this.firstFailure) throw this.firstFailure.error;
  }

  /**
   * Preserve the legacy drain meaning for callers while making the barrier
   * explicit: all items accepted before this call are committed before it
   * resolves.
   */
  async drain(options: PiWriterCompletionOptions = {}): Promise<void> {
    const barrier = this.flush();
    let barrierFailure: unknown;

    try {
      await this.awaitWithBudget(barrier, options);
    } catch (error) {
      barrierFailure = error;
    }

    if (barrierFailure !== undefined || this.firstFailure) {
      try {
        await this.awaitConsumer(options);
      } catch (error) {
        this.recordFailure(error, "cleanup");
        Effect.runFork(Fiber.interrupt(this.consumer));
        throw this.firstFailure?.error ?? error;
      }
    }

    try {
      await this.awaitAbortCompletion(options);
    } catch (error) {
      this.recordFailure(error, "cleanup");
      throw this.firstFailure?.error ?? error;
    }

    if (this.firstFailure) throw this.firstFailure.error;

    if (barrierFailure !== undefined) throw barrierFailure;
  }

  /** Reject late callbacks. Normal completion still drains already accepted items. */
  close(): void {
    if (!this.accepting) return;
    this.accepting = false;
    Queue.endUnsafe(this.queue);
  }

  private admit(input: Omit<PiWriterItem, "acknowledgement">): Promise<void> {
    const acknowledgement = Deferred.makeUnsafe<void, unknown>();
    const item: PiWriterItem = { ...input, acknowledgement };

    if (!this.accepting || this.firstFailure) {
      this.rejectAcknowledgement(item, this.firstFailure?.error ?? new PiWriterClosedError());

      return this.promiseFor(item);
    }

    try {
      this.assertAdmissible(input.sizeBytes);
    } catch (error) {
      this.rejectAcknowledgement(item, error);

      return this.promiseFor(item);
    }

    // offerUnsafe is the selected RC's synchronous admission operation. The
    // item is not copied or retained until all limits have passed.
    if (!Queue.offerUnsafe(this.queue, item)) {
      const overflow = new PiPersistenceOverflowError(this.itemLimit, this.byteLimit);
      this.recordFailure(overflow, "overflow");
      this.rejectAcknowledgement(item, overflow);

      return this.promiseFor(item);
    }

    this.pending.add(item);
    this.admittedItems += 1;
    this.retainedBytes += input.sizeBytes;

    return this.promiseFor(item);
  }

  private assertAdmissible(sizeBytes: number): void {
    if (
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 0 ||
      sizeBytes > this.byteLimit ||
      this.admittedItems >= this.itemLimit ||
      sizeBytes > this.byteLimit - this.retainedBytes
    ) {
      const overflow = new PiPersistenceOverflowError(this.itemLimit, this.byteLimit);
      this.recordFailure(overflow, "overflow");
      throw overflow;
    }
  }

  private promiseFor(item: PiWriterItem): Promise<void> {
    const result = Effect.runPromise(Deferred.await(item.acknowledgement));
    void result.catch(() => undefined);

    return result;
  }

  private rejectAcknowledgement(item: PiWriterItem, error: unknown): void {
    Effect.runSync(Deferred.fail(item.acknowledgement, error));
  }

  private settle(item: PiWriterItem, error?: unknown): void {
    if (!this.pending.delete(item)) return;
    this.admittedItems -= 1;
    this.retainedBytes -= item.sizeBytes;

    if (error === undefined && this.failureMode !== "persistence")
      Effect.runSync(Deferred.succeed(item.acknowledgement, undefined));
    else this.rejectAcknowledgement(item, error ?? this.firstFailure?.error);
  }

  private recordFailure(error: unknown, mode: PiWriterFailureMode = "persistence"): void {
    if (
      this.firstFailure &&
      !(
        (this.failureMode === "overflow" || this.failureMode === "producer") &&
        mode === "persistence"
      )
    )
      return;
    this.firstFailure = { error };
    this.failureMode = mode;
    this.accepting = false;

    // Overflow and producer validation failures close admission but drain
    // accepted writes. A persistence failure discards later writes and leaves
    // the first store failure authoritative.
    if (mode === "overflow" || mode === "producer") Queue.endUnsafe(this.queue);
    else Effect.runSync(Queue.shutdown(this.queue));

    if (mode !== "overflow" && mode !== "producer") {
      for (const item of this.pending) this.settle(item, error);
    }

    if (this.onFailure) {
      try {
        this.abortCompletion = Promise.resolve(this.onFailure(error)).catch(() => undefined);
      } catch {
        this.abortCompletion = Promise.resolve();
      }
    }
  }

  private consume(): Effect.Effect<void> {
    return Effect.scoped(
      Effect.acquireRelease(Effect.succeed(this.queue), () => Queue.shutdown(this.queue)).pipe(
        Effect.flatMap(() =>
          Stream.fromQueue(this.queue).pipe(
            Stream.runForEach((item) => this.process(item)),
            Effect.catch(() => Effect.void),
          ),
        ),
      ),
    );
  }

  private awaitConsumer(options: PiWriterCompletionOptions): Promise<void> {
    const wait = Fiber.await(this.consumer).pipe(
      Effect.timeoutOrElse({
        duration: options.timeoutMs ?? this.cleanupTimeoutMs,
        orElse: () => Effect.fail(new PiPersistenceCleanupError("timeout")),
      }),
    );

    if (!options.signal) return Effect.runPromise(Effect.asVoid(wait));

    const interrupted = Effect.callback<never, PiPersistenceCleanupError>((resume) => {
      const abort = () => resume(Effect.fail(new PiPersistenceCleanupError("cancelled")));

      if (options.signal?.aborted) {
        abort();

        return;
      }

      options.signal?.addEventListener("abort", abort, { once: true });

      return Effect.sync(() => options.signal?.removeEventListener("abort", abort));
    });

    return Effect.runPromise(Effect.raceFirst(Effect.asVoid(wait), interrupted));
  }

  private awaitAbortCompletion(options: PiWriterCompletionOptions): Promise<void> {
    return this.awaitWithBudget(this.abortCompletion, options);
  }

  private async awaitWithBudget<T>(
    promise: PromiseLike<T>,
    options: PiWriterCompletionOptions,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    let abort: (() => void) | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new PiPersistenceCleanupError("timeout")),
        options.timeoutMs ?? this.cleanupTimeoutMs,
      );
    });

    const cancellation = options.signal
      ? new Promise<never>((_, reject) => {
          abort = () => reject(new PiPersistenceCleanupError("cancelled"));

          if (options.signal?.aborted) abort();
          else options.signal?.addEventListener("abort", abort, { once: true });
        })
      : undefined;

    try {
      return await Promise.race(
        cancellation ? [promise, timeout, cancellation] : [promise, timeout],
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);

      if (abort) options.signal?.removeEventListener("abort", abort);
    }
  }

  private process(item: PiWriterItem): Effect.Effect<void, unknown> {
    if (this.firstFailure && this.failureMode !== "overflow" && this.failureMode !== "producer") {
      this.settle(item, this.firstFailure.error);

      return Effect.void;
    }

    return Effect.tryPromise({
      try: () => Promise.resolve(item.write()),
      catch: (error: unknown) => error,
    }).pipe(
      Effect.tapError((error) => Effect.sync(() => this.recordFailure(error))),
      Effect.tap(() => Effect.sync(() => this.settle(item))),
      Effect.asVoid,
    );
  }
}

export const PI_WRITER_DEFAULT_ITEM_LIMIT = defaultItemLimit;

export const PI_WRITER_DEFAULT_BYTE_LIMIT = defaultByteLimit;

export const PI_WRITER_DEFAULT_CLEANUP_TIMEOUT_MS = defaultCleanupTimeoutMs;
