ALTER TABLE "command_operation" DROP CONSTRAINT "command_operation_state_check";
--> statement-breakpoint
ALTER TABLE "demo_compute_month_allocation" DROP CONSTRAINT "demo_compute_month_allocation_consumed_check";
--> statement-breakpoint
ALTER TABLE "demo_compute_month_allocation" DROP CONSTRAINT "demo_compute_month_allocation_reserved_check";
--> statement-breakpoint
ALTER TABLE "demo_compute_reservation" DROP CONSTRAINT "demo_compute_reservation_reserved_seconds_check";
--> statement-breakpoint
ALTER TABLE "demo_compute_reservation" DROP CONSTRAINT "demo_compute_reservation_baseline_seconds_check";
--> statement-breakpoint
ALTER TABLE "demo_compute_reservation" DROP CONSTRAINT "demo_compute_reservation_consumed_seconds_check";
--> statement-breakpoint
ALTER TABLE "demo_compute_reservation" DROP CONSTRAINT "demo_compute_reservation_observed_seconds_check";
--> statement-breakpoint
ALTER TABLE "demo_compute_usage" DROP CONSTRAINT "demo_compute_usage_seconds_check";
--> statement-breakpoint
ALTER TABLE "demo_compute_month_allocation" DROP CONSTRAINT "demo_compute_month_allocation_reservation_id_fkey";

--> statement-breakpoint
ALTER TABLE "demo_compute_reservation" DROP CONSTRAINT "demo_compute_reservation_workspace_id_fkey";

--> statement-breakpoint
ALTER TABLE "demo_compute_reservation" DROP CONSTRAINT "demo_compute_reservation_run_id_fkey";

--> statement-breakpoint
ALTER TABLE "demo_turn" DROP CONSTRAINT "demo_turn_run_id_fkey";

--> statement-breakpoint
ALTER TABLE "demo_turn" DROP CONSTRAINT "demo_turn_user_id_fkey";

--> statement-breakpoint
DROP INDEX "command_operation_unsettled_workspace_generation_idx";
--> statement-breakpoint
ALTER TABLE "command_operation" ADD COLUMN "access" text DEFAULT 'exclusive' NOT NULL;
--> statement-breakpoint
ALTER TABLE "command_operation" ADD COLUMN "read_slot" integer;
--> statement-breakpoint
ALTER TABLE "command_operation" ADD COLUMN "ownership_token" uuid;
--> statement-breakpoint
ALTER TABLE "command_operation" ADD COLUMN "queue_order" bigserial NOT NULL;
--> statement-breakpoint
ALTER TABLE "demo_compute_month_allocation" ADD CONSTRAINT "demo_compute_month_allocation_reservation_id_demo_compute_reservation_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."demo_compute_reservation"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "demo_compute_reservation" ADD CONSTRAINT "demo_compute_reservation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "demo_compute_reservation" ADD CONSTRAINT "demo_compute_reservation_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "demo_turn" ADD CONSTRAINT "demo_turn_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "demo_turn" ADD CONSTRAINT "demo_turn_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "command_operation" ADD CONSTRAINT "command_operation_access_check" CHECK ("command_operation"."access" in ('exclusive', 'read'));
--> statement-breakpoint
ALTER TABLE "command_operation" ADD CONSTRAINT "command_operation_read_slot_check" CHECK (("command_operation"."access" = 'exclusive' and "command_operation"."read_slot" is null) or ("command_operation"."access" = 'read' and (("command_operation"."state" in ('queued', 'completed', 'failed') and "command_operation"."read_slot" is null) or ("command_operation"."read_slot" is not null and "command_operation"."read_slot" between 1 and 4))));
--> statement-breakpoint
ALTER TABLE "command_operation" ADD CONSTRAINT "command_operation_state_check" CHECK ("command_operation"."state" in ('queued', 'pending', 'running', 'completed', 'failed', 'unknown'));
--> statement-breakpoint
ALTER TABLE "demo_compute_month_allocation" ADD CONSTRAINT "demo_compute_month_consumed_nonnegative" CHECK ("demo_compute_month_allocation"."consumed" >= 0);
--> statement-breakpoint
ALTER TABLE "demo_compute_month_allocation" ADD CONSTRAINT "demo_compute_month_reserved_nonnegative" CHECK ("demo_compute_month_allocation"."reserved" >= 0);
--> statement-breakpoint
ALTER TABLE "demo_compute_reservation" ADD CONSTRAINT "demo_compute_reserved_positive" CHECK ("demo_compute_reservation"."reserved_seconds" > 0);
--> statement-breakpoint
ALTER TABLE "demo_compute_reservation" ADD CONSTRAINT "demo_compute_observed_nonnegative" CHECK ("demo_compute_reservation"."observed_seconds" >= 0);
--> statement-breakpoint
ALTER TABLE "demo_compute_reservation" ADD CONSTRAINT "demo_compute_baseline_nonnegative" CHECK ("demo_compute_reservation"."baseline_seconds" >= 0);
--> statement-breakpoint
ALTER TABLE "demo_compute_reservation" ADD CONSTRAINT "demo_compute_consumed_nonnegative" CHECK ("demo_compute_reservation"."consumed_seconds" >= 0);
--> statement-breakpoint
ALTER TABLE "demo_compute_usage" ADD CONSTRAINT "demo_compute_usage_nonnegative" CHECK ("demo_compute_usage"."seconds" >= 0);
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE command_operation ADD CONSTRAINT command_operation_access_exclusion EXCLUDE USING gist (workspace_id WITH =, generation WITH =, (CASE WHEN access = 'exclusive' THEN int4range(0, 5) ELSE int4range(read_slot, read_slot + 1) END) WITH &&) WHERE (state IN ('pending', 'running', 'unknown'));
--> statement-breakpoint
ALTER TABLE outbox DROP COLUMN payload;
