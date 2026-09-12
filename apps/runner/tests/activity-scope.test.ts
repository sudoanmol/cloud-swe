import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import pino from "pino";
import { Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import {
  workspaceLock,
  withActivityHeartbeat,
  type WorkspaceLockOptions,
} from "../src/activity-scope.js";

function supervisedLock<T>(
  options: WorkspaceLockOptions & { pulse: () => void },
  work: (signal: AbortSignal) => Promise<T>,
) {
  return withActivityHeartbeat(workspaceLock(options, work), options.pulse);
}

const baseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:password@localhost:5432/cloud-swe";

const database = `activity_scope_${randomUUID().replaceAll("-", "")}`;

const admin = new Pool({ connectionString: baseUrl });

const url = new URL(baseUrl);

url.pathname = `/${database}`;

const logs: string[] = [];

const logger = pino(
  { level: "warn" },
  {
    write: (line) => {
      logs.push(line);
    },
  },
);

const makePool = () =>
  new Pool({
    connectionString: url.toString(),
    max: 1,
    connectionTimeoutMillis: 1_000,
    query_timeout: 1_000,
  });

beforeAll(async () => {
  await admin.query(`create database "${database}"`);
  const pool = makePool();

  try {
    await pool.query("create table thread (id text primary key, user_id text not null)");
    await pool.query("insert into thread values ('thread', 'user')");
  } finally {
    await pool.end();
  }
});

afterAll(async () => {
  await admin.query(`drop database if exists "${database}"`);
  await admin.end();
});

test("normal completion unlocks and removes the connection listener", async () => {
  const pool = makePool();
  let connection: PoolClient | undefined;
  pool.on("acquire", (client) => {
    connection = client;
  });

  try {
    expect(
      await Effect.runPromise(
        supervisedLock({ pool, threadId: "thread", pulse: () => {}, logger }, async () => 42),
      ),
    ).toBe(42);
    expect(pool.idleCount).toBe(1);
    // node-postgres installs its own idle listener on release.
    expect(connection?.listenerCount("error")).toBe(1);

    const result = await pool.query<{ count: string }>(
      "select count(*) from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()",
    );

    expect(result.rows[0]?.count).toBe("0");
  } finally {
    await pool.end();
  }
});

test("heartbeat failure aborts protected work and drains it before release", async () => {
  const pool = makePool();
  const started = Promise.withResolvers<void>();
  let pulses = 0;
  let aborted = 0;

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* supervisedLock(
          {
            pool,
            threadId: "thread",
            logger,
            pulse: () => {
              pulses++;

              if (pulses === 2) throw new Error("heartbeat unavailable");
            },
          },
          async (signal) => {
            started.resolve();
            await new Promise<void>((resolve) =>
              signal.addEventListener(
                "abort",
                () => {
                  aborted++;
                  resolve();
                },
                { once: true },
              ),
            );
          },
        ).pipe(Effect.forkChild);

        yield* Effect.promise(() => started.promise);
        yield* TestClock.adjust(1_000);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(aborted).toBe(1);
        expect(pool.idleCount).toBe(1);
        yield* TestClock.adjust(5_000);
        expect(pulses).toBe(2);
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
    );
  } finally {
    await pool.end();
  }
});

test("lock waits are interruptible and continue heartbeating", async () => {
  const blocker = makePool();
  const pool = makePool();
  let pulses = 0;
  let executed = false;
  await blocker.query("select pg_advisory_lock(hashtextextended('workspace-user:user', 0))");

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* supervisedLock(
          {
            pool,
            threadId: "thread",
            logger,
            pulse: () => {
              pulses++;
            },
          },
          async () => {
            executed = true;
          },
        ).pipe(Effect.forkChild);

        yield* TestClock.adjust(2_000);
        yield* Fiber.interrupt(fiber);
        expect(executed).toBe(false);
        expect(pulses).toBeGreaterThanOrEqual(2);
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
    );
  } finally {
    await blocker.end();
    await pool.end();
  }
});

test("connection loss aborts execution and destroys the connection", async () => {
  const pool = makePool();
  const started = Promise.withResolvers<void>();
  let connection: PoolClient | undefined;
  let aborted = false;
  pool.on("acquire", (client) => {
    connection = client;
  });

  try {
    const running = Effect.runPromiseExit(
      supervisedLock({ pool, threadId: "thread", logger, pulse: () => {} }, async (signal) => {
        started.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          ),
        );
      }),
    );

    await started.promise;
    connection?.emit("error", new Error("connection lost"));
    expect(Exit.isFailure(await running)).toBe(true);
    expect(aborted).toBe(true);
    expect(pool.totalCount).toBe(0);
    expect(connection?.listenerCount("error")).toBe(1);
  } finally {
    await pool.end();
  }
});

test("an unsuccessful unlock destroys the connection", async () => {
  const pool = makePool();
  let connection: PoolClient | undefined;
  pool.on("acquire", (client) => {
    connection = client;
  });

  try {
    await Effect.runPromise(
      supervisedLock({ pool, threadId: "thread", logger, pulse: () => {} }, async () => {
        await connection?.query("select pg_advisory_unlock_all()");
      }),
    );
    expect(pool.totalCount).toBe(0);
    expect(logs.some((line) => line.includes("Workspace lock release failed"))).toBe(true);
  } finally {
    await pool.end();
  }
});

test("cancellation during pool acquisition destroys a connection delivered late", async () => {
  const pool = makePool();
  const borrowed = await pool.connect();

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* supervisedLock(
          { pool, threadId: "thread", logger, pulse: () => {} },
          async () => {
            throw new Error("must not execute");
          },
        ).pipe(Effect.forkChild);

        yield* Effect.yieldNow;
        expect(pool.waitingCount).toBe(1);
        yield* Fiber.interrupt(fiber);
        const removed = new Promise<void>((resolve) => pool.once("remove", () => resolve()));
        borrowed.release();
        yield* Effect.promise(() => removed);
        expect(pool.totalCount).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
    );
  } finally {
    await pool.end();
  }
});

test("cancellation after lock acquisition does not start protected work", async () => {
  const pool = makePool();
  const cancellation = new AbortController();
  let executed = false;

  pool.on("connect", (client) => {
    const query = client.query.bind(client);
    Object.defineProperty(client, "query", {
      configurable: true,
      value: (config: { text: string; values?: string[] }) => {
        if (!config.text.includes("pg_try_advisory_lock")) return query(config);

        return query(config).then((result) => {
          queueMicrotask(() => cancellation.abort());

          return result;
        });
      },
    });
  });

  try {
    const exit = await Effect.runPromiseExit(
      workspaceLock({ pool, threadId: "thread", logger }, async () => {
        executed = true;
      }),
      { signal: cancellation.signal },
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(executed).toBe(false);
  } finally {
    await pool.end();
  }
});

test("a cleanup timeout fails the activity and destroys its lock connection", async () => {
  const pool = makePool();
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<void>();
  let pulses = 0;

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* supervisedLock(
          {
            pool,
            threadId: "thread",
            logger,
            cleanupMs: 50,
            pulse: () => {
              if (++pulses === 2) throw new Error("heartbeat failed");
            },
          },
          async () => {
            started.resolve();
            await pending.promise;
          },
        ).pipe(Effect.forkChild);

        yield* Effect.promise(() => started.promise);
        yield* TestClock.adjust(1_000);
        yield* TestClock.adjust(50);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(pool.totalCount).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
    );
  } finally {
    pending.resolve();
    await pool.end();
  }
});
