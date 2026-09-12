import type { Pool } from "pg";
import { z } from "zod";
import { ThreadStoreError } from "@cloud-swe/db/thread-contracts";

const reservationSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  workspace_id: z.string(),
  provider_id: z.string().nullable(),
  reserved_seconds: z.number().finite().positive(),
  baseline_seconds: z.number().finite().nonnegative(),
  observed_seconds: z.number().finite().nonnegative(),
  started_at: z.date(),
  latest_start_at: z.date().nullable(),
  settled_at: z.date().nullable(),
  consumed_seconds: z.number().nullable(),
});

export type ComputeReservation = z.infer<typeof reservationSchema>;

const currentRunSchema = z.object({ id: z.string(), access_policy: z.enum(["owner", "demo"]) });

export function createDemoCompute(pool: Pool, monthlySeconds = 18000) {
  async function account(
    workspaceId: string,
    totalRunSeconds: number | null,
    settled: boolean,
    providerId?: string | null,
  ) {
    if (totalRunSeconds !== null) z.number().finite().nonnegative().parse(totalRunSeconds);
    const client = await pool.connect();

    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('cloud-swe:demo-compute:v1'))");

      const result = await client.query(
        "select * from demo_compute_reservation where workspace_id = $1 and settled_at is null and ($2::boolean or provider_id is not distinct from $3::text) order by started_at desc limit 1 for update",
        [workspaceId, providerId === undefined, providerId ?? null],
      );

      if (result.rows[0]) {
        const reservation = reservationSchema.parse(result.rows[0]);

        // Absence proves that execution stopped, not how much runtime was used.
        // Keep unaccounted capacity until provider runtime can be confirmed.
        if (totalRunSeconds === null) {
          await client.query("commit");

          return;
        }

        const seconds = Math.max(
          reservation.observed_seconds,
          totalRunSeconds - reservation.baseline_seconds,
        );

        const earliest = reservation.started_at.getTime();

        // Runtime is cumulative across this one permitted start. A response's
        // arrival time bounds the start from above; it never proves an exact start.
        const latest = Math.max(
          earliest,
          Math.min(reservation.latest_start_at?.getTime() ?? Infinity, Date.now() - seconds * 1000),
        );

        const previous = z
          .array(z.object({ month: z.string(), consumed: z.number() }))
          .parse(
            (
              await client.query(
                "select to_char(month, 'YYYY-MM-DD') as month, consumed from demo_compute_month_allocation where reservation_id=$1",
                [reservation.id],
              )
            ).rows,
          );

        const allocations = allocateRuntimeMonths(earliest, latest, seconds);
        const oldAmounts = new Map(previous.map((row) => [row.month, row.consumed]));

        for (const allocation of allocations) {
          const delta = allocation.consumed - (oldAmounts.get(allocation.month) ?? 0);
          await client.query(
            `insert into demo_compute_usage(month,seconds) values ($1,$2)
            on conflict (month) do update set seconds=demo_compute_usage.seconds+excluded.seconds`,
            [allocation.month, delta],
          );
          await client.query(
            `insert into demo_compute_month_allocation(reservation_id,month,consumed,reserved) values ($1,$2,$3,$4)
            on conflict (reservation_id,month) do update set consumed=excluded.consumed,reserved=excluded.reserved`,
            [reservation.id, allocation.month, allocation.consumed, allocation.reserved],
          );
          oldAmounts.delete(allocation.month);
        }

        for (const [month, amount] of oldAmounts) {
          await client.query(
            "update demo_compute_usage set seconds=greatest(0,seconds-$2) where month=$1",
            [month, amount],
          );
          await client.query(
            "delete from demo_compute_month_allocation where reservation_id=$1 and month=$2",
            [reservation.id, month],
          );
        }

        await client.query(
          "update demo_compute_reservation set observed_seconds=$2::double precision, latest_start_at=$4, settled_at=case when $3::boolean then now() else null end, consumed_seconds=case when $3::boolean then $2::double precision else null end where id=$1",
          [reservation.id, seconds, settled, new Date(latest)],
        );
      }

      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    async observations() {
      return reservationSchema
        .array()
        .parse(
          (
            await pool.query(
              "select * from demo_compute_reservation where settled_at is null and provider_id is not null",
            )
          ).rows,
        );
    },
    observe: (workspaceId: string, totalRunSeconds: number, providerId?: string) =>
      account(workspaceId, totalRunSeconds, false, providerId),
    settle: (workspaceId: string, totalRunSeconds: number | null, providerId?: string | null) =>
      account(workspaceId, totalRunSeconds, true, providerId),
    async currentRun(threadId: string) {
      const result = await pool.query(
        "select id, access_policy from run where thread_id = $1 and status in ('queued','running')",
        [threadId],
      );

      return currentRunSchema.parse(result.rows[0]);
    },
    async outstanding(workspaceId: string, providerId?: string | null) {
      const result = await pool.query(
        "select * from demo_compute_reservation where workspace_id = $1 and settled_at is null and ($2::boolean or provider_id is not distinct from $3::text) order by started_at desc limit 1",
        [workspaceId, providerId === undefined, providerId ?? null],
      );

      return result.rows[0] ? reservationSchema.parse(result.rows[0]) : null;
    },
    async reserve(input: {
      workspaceId: string;
      runId: string;
      seconds: number;
      baselineSeconds: number;
      providerId: string | null;
    }) {
      const client = await pool.connect();

      try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtext('cloud-swe:demo-compute:v1'))");

        const prior = await client.query(
          "select * from demo_compute_reservation where run_id = $1 and workspace_id = $2 and (provider_id is not distinct from $3::text or provider_id is null) order by started_at desc limit 1",
          [input.runId, input.workspaceId, input.providerId],
        );

        if (prior.rows[0]) {
          const reservation = reservationSchema.parse(prior.rows[0]);

          if (
            reservation.settled_at ||
            Date.now() >= reservation.started_at.getTime() + reservation.reserved_seconds * 1000
          )
            throw new ThreadStoreError("DEMO_RUNTIME_EXPIRED", "Demo runtime reservation expired");
          await client.query("commit");

          return reservation;
        }

        const usage = await client.query(`select
          coalesce((select sum(seconds) from demo_compute_usage where month = date_trunc('month', now() at time zone 'UTC')::date),0)::float8 consumed,
          (coalesce((select sum(greatest(reserved_seconds-observed_seconds,0)) from demo_compute_reservation where settled_at is null),0)
          + coalesce((select sum(reserved) from demo_compute_month_allocation where month = date_trunc('month', now() at time zone 'UTC')::date),0))::float8 reserved`);

        const totals = z
          .object({ consumed: z.number(), reserved: z.number() })
          .parse(usage.rows[0]);

        if (totals.consumed + totals.reserved + input.seconds > monthlySeconds)
          throw new ThreadStoreError(
            totals.consumed + input.seconds > monthlySeconds
              ? "DEMO_BUDGET_CONSUMED"
              : "DEMO_BUDGET_RESERVED",
            "Demo compute budget unavailable",
            429,
          );

        const created = await client.query(
          `insert into demo_compute_reservation(workspace_id,run_id,reserved_seconds,baseline_seconds,provider_id)
          values ($1,$2,$3,$4,$5) returning *`,
          [input.workspaceId, input.runId, input.seconds, input.baselineSeconds, input.providerId],
        );

        const reservation = reservationSchema.parse(created.rows[0]);
        await client.query("commit");

        return reservation;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async attach(id: string, providerId: string) {
      await pool.query(
        "update demo_compute_reservation set provider_id = $2 where id = $1 and (provider_id is null or provider_id = $2)",
        [id, providerId],
      );
    },
  };
}

export type DemoCompute = ReturnType<typeof createDemoCompute>;

/** Guaranteed runtime is consumed. Ambiguous month attribution stays reserved. */
export function allocateRuntimeMonths(earliest: number, latest: number, seconds: number) {
  const allocations: Array<{ month: string; consumed: number; reserved: number }> = [];

  if (seconds <= 0) return allocations;
  const first = new Date(earliest);
  let cursor = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1);
  const duration = seconds * 1000;

  while (cursor < latest + duration) {
    const month = new Date(cursor);
    const end = Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1);

    const overlap = (start: number) =>
      Math.max(0, Math.min(end, start + duration) - Math.max(cursor, start)) / 1000;

    const clamp = (start: number) => Math.min(latest, Math.max(earliest, start));
    const minimum = Math.min(overlap(earliest), overlap(latest));

    const maximum = Math.max(
      overlap(earliest),
      overlap(latest),
      overlap(clamp(cursor)),
      overlap(clamp(end - duration)),
    );

    if (maximum > 0)
      allocations.push({
        month: month.toISOString().slice(0, 10),
        consumed: minimum,
        reserved: maximum - minimum,
      });
    cursor = end;
  }

  return allocations;
}
