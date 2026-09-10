ALTER TABLE "workspace" RENAME COLUMN "docker_name" TO "name";
--> statement-breakpoint
ALTER TABLE "workspace" RENAME CONSTRAINT "workspace_docker_name_unique" TO "workspace_name_unique";
--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "lifecycle_transition_id" uuid;
--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "lifecycle_transition_state" text;
--> statement-breakpoint
ALTER TABLE "workspace" DROP CONSTRAINT "workspace_state_check";
--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_state_check" CHECK ("workspace"."state" in ('provisioning', 'running', 'paused', 'deleted', 'failed', 'quarantined', 'recovery'));
--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_generation_check" CHECK ("workspace"."generation" >= 1);
--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_transition_state_check" CHECK ("workspace"."lifecycle_transition_state" is null or "workspace"."lifecycle_transition_state" in ('provisioning', 'running', 'paused', 'deleted', 'failed', 'quarantined', 'recovery'));
--> statement-breakpoint
ALTER TABLE "agent_checkpoint" ADD COLUMN "key" text;
--> statement-breakpoint
UPDATE "agent_checkpoint"
SET "key" = CASE
  WHEN "content"->>'kind' = 'pi' THEN 'pi-session'
  WHEN "content"->>'kind' = 'pi.completed' THEN 'pi-completed'
  ELSE 'scripted-step-' || "step"::text
END;
--> statement-breakpoint
ALTER TABLE "agent_checkpoint" ALTER COLUMN "key" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_checkpoint" DROP COLUMN "step";
--> statement-breakpoint
ALTER TABLE "agent_checkpoint" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
UPDATE "agent_checkpoint" AS checkpoint
SET "generation" = workspace."generation"
FROM "run" AS run_record
JOIN "workspace" AS workspace ON workspace."thread_id" = run_record."thread_id"
WHERE checkpoint."run_id" = run_record."id";
--> statement-breakpoint
ALTER TABLE "agent_checkpoint" ADD COLUMN "attempt_id" text;
--> statement-breakpoint
ALTER TABLE "agent_checkpoint" DROP CONSTRAINT IF EXISTS "agent_checkpoint_run_step_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "agent_checkpoint_run_step_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_checkpoint_run_key_idx" ON "agent_checkpoint" USING btree ("run_id", "key");
--> statement-breakpoint
CREATE INDEX "agent_checkpoint_generation_idx" ON "agent_checkpoint" USING btree ("run_id", "generation");
--> statement-breakpoint
ALTER TABLE "agent_checkpoint" ADD CONSTRAINT "agent_checkpoint_generation_check" CHECK ("agent_checkpoint"."generation" >= 1);
--> statement-breakpoint
CREATE TABLE "command_operation" (
  "command_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "generation" integer NOT NULL,
  "run_id" uuid NOT NULL,
  "attempt_id" text NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "cancellation_requested" boolean DEFAULT false NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "result" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  CONSTRAINT "command_operation_generation_check" CHECK ("command_operation"."generation" >= 1),
  CONSTRAINT "command_operation_state_check" CHECK ("command_operation"."state" in ('pending', 'running', 'completed', 'failed', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "command_operation" ADD CONSTRAINT "command_operation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "command_operation" ADD CONSTRAINT "command_operation_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "command_operation_unsettled_workspace_generation_idx" ON "command_operation" USING btree ("workspace_id", "generation") WHERE "command_operation"."state" in ('pending', 'running', 'unknown');
--> statement-breakpoint
CREATE INDEX "command_operation_workspace_generation_idx" ON "command_operation" USING btree ("workspace_id", "generation");
--> statement-breakpoint
CREATE INDEX "command_operation_run_idx" ON "command_operation" USING btree ("run_id");
