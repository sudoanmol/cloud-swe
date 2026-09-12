DROP INDEX "run_one_active_user_idx";
--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "access_policy" text NOT NULL DEFAULT 'demo' CHECK (access_policy IN ('owner', 'demo'));
ALTER TABLE "run" ADD COLUMN "agent_started_at" timestamptz;
--> statement-breakpoint
CREATE TABLE demo_turn (
 run_id uuid PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 state text NOT NULL CHECK (state IN ('reserved', 'consumed', 'released'))
);
CREATE INDEX demo_turn_user_idx ON demo_turn(user_id);
INSERT INTO demo_turn(run_id, user_id, state)
SELECT id, user_id, CASE WHEN status = 'completed' THEN 'consumed' ELSE 'reserved' END
FROM run WHERE status IN ('completed', 'queued', 'running');
UPDATE run SET agent_started_at = to_timestamp((c.content->>'startedAt')::double precision / 1000)
FROM agent_checkpoint c WHERE c.run_id = run.id AND c.key = 'execution-started'
AND jsonb_typeof(c.content->'startedAt') = 'number';
--> statement-breakpoint
CREATE TABLE demo_compute_reservation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspace(id),
 run_id uuid NOT NULL REFERENCES run(id),
 provider_id text,
 reserved_seconds double precision NOT NULL CHECK (reserved_seconds > 0),
 observed_seconds double precision NOT NULL DEFAULT 0 CHECK (observed_seconds >= 0),
 baseline_seconds double precision NOT NULL CHECK (baseline_seconds >= 0),
 started_at timestamptz NOT NULL DEFAULT now(),
 latest_start_at timestamptz,
 settled_at timestamptz,
 consumed_seconds double precision CHECK (consumed_seconds >= 0)
);
CREATE UNIQUE INDEX demo_compute_unbound_workspace_idx ON demo_compute_reservation(workspace_id) WHERE settled_at IS NULL AND provider_id IS NULL;
CREATE UNIQUE INDEX demo_compute_run_provider_idx ON demo_compute_reservation(run_id,workspace_id,provider_id) WHERE provider_id IS NOT NULL;
CREATE TABLE demo_compute_usage (
 month date PRIMARY KEY,
 seconds double precision NOT NULL CHECK (seconds >= 0)
);

--> statement-breakpoint
CREATE TABLE demo_compute_month_allocation (
 reservation_id uuid NOT NULL REFERENCES demo_compute_reservation(id) ON DELETE CASCADE,
 month date NOT NULL,
 consumed double precision NOT NULL CHECK (consumed >= 0),
 reserved double precision NOT NULL CHECK (reserved >= 0),
 PRIMARY KEY (reservation_id, month)
);
