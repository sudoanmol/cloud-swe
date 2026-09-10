export type Awaitable<T> = T | PromiseLike<T>;

export type PiWriterFailureHandler = (error: unknown) => Awaitable<void>;

export interface OrderedPiWriterOptions {
  onFailure?: PiWriterFailureHandler;
}

export interface PiWriterFailure {
  readonly error: unknown;
}

/**
 * Serializes all persistence operations for one Pi attempt.
 *
 * Every operation gets a rejecting promise for its caller, while the writer
 * also attaches an observation to that promise so fire-and-forget event
 * handlers cannot create an unhandled rejection. Once an operation fails, the
 * first error becomes terminal: queued and future operations are rejected and
 * the failure callback is invoked exactly once.
 */
export class OrderedPiWriter {
  private tail: Promise<void> = Promise.resolve();
  private firstFailure: PiWriterFailure | undefined;
  private abortCompletion: Promise<void> = Promise.resolve();
  private readonly onFailure: PiWriterFailureHandler | undefined;

  constructor(options: OrderedPiWriterOptions = {}) {
    this.onFailure = options.onFailure;
  }

  get failure(): PiWriterFailure | undefined {
    return this.firstFailure;
  }

  get failed(): boolean {
    return this.firstFailure !== undefined;
  }

  /**
   * Queue one event or checkpoint persistence operation.
   *
   * The returned promise rejects with the operation's error. It is safe to
   * ignore that promise from synchronous Pi event listeners because the writer
   * observes it internally; callers that need the error can still await it.
   */
  enqueue(operation: () => Awaitable<void>): Promise<void> {
    if (this.firstFailure) return this.rejected(this.firstFailure.error);

    const result = this.tail.then(async () => {
      if (this.firstFailure) throw this.firstFailure.error;
      try {
        await operation();
      } catch (error) {
        this.recordFailure(error);
        throw error;
      }
    });

    // Keep the internal tail fulfilled so later queue entries can observe the
    // terminal failure and reject themselves instead of making the chain noisy.
    this.tail = result.then(
      () => undefined,
      (error: unknown) => {
        this.recordFailure(error);
      },
    );

    // A Pi session listener may not await this promise. Mark it observed while
    // preserving the rejecting promise returned to an explicit caller.
    void result.catch(() => undefined);
    return result;
  }

  /** Alias used by callers that model persistence as a write operation. */
  write(operation: () => Awaitable<void>): Promise<void> {
    return this.enqueue(operation);
  }

  /**
   * Wait until every operation queued so far (including rejected operations)
   * has settled, then surface the first persistence failure.
   */
  async drain(): Promise<void> {
    while (true) {
      const tail = this.tail;
      await tail;
      if (tail === this.tail) break;
    }
    await this.abortCompletion;
    if (this.firstFailure) throw this.firstFailure.error;
  }

  private rejected(error: unknown): Promise<void> {
    const result = Promise.reject(error);
    void result.catch(() => undefined);
    return result;
  }

  private recordFailure(error: unknown): void {
    if (this.firstFailure) return;
    this.firstFailure = { error };
    if (!this.onFailure) return;

    try {
      this.abortCompletion = Promise.resolve(this.onFailure(error)).catch(() => undefined);
    } catch {
      // The persistence failure remains authoritative even if abort setup
      // itself fails. The rejected abort promise is intentionally observed.
      this.abortCompletion = Promise.resolve();
    }
  }
}

export function createOrderedPiWriter(options: OrderedPiWriterOptions = {}): OrderedPiWriter {
  return new OrderedPiWriter(options);
}
