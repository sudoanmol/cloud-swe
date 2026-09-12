CREATE TABLE "git_operation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"generation" integer NOT NULL,
	"repository_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"proposal" jsonb NOT NULL,
	"approval" text DEFAULT 'pending' NOT NULL,
	"execution" text DEFAULT 'not_started' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"result" jsonb,
	CONSTRAINT "git_operation_generation_check" CHECK ("git_operation"."generation" > 0),
	CONSTRAINT "git_operation_approval_check" CHECK ("git_operation"."approval" in ('pending','approved','rejected','expired','invalidated')),
	CONSTRAINT "git_operation_execution_check" CHECK ("git_operation"."execution" in ('not_started','executing','succeeded','failed','unknown'))
);

--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "approval_wait_started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "approval_wait_ms" double precision DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "git_operation" ADD CONSTRAINT "git_operation_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "git_operation" ADD CONSTRAINT "git_operation_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "git_operation" ADD CONSTRAINT "git_operation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "git_operation_tool_idx" ON "git_operation" USING btree ("run_id","tool_call_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "git_operation_pending_run_idx" ON "git_operation" USING btree ("run_id") WHERE "git_operation"."approval" = 'pending';
--> statement-breakpoint
CREATE UNIQUE INDEX "git_operation_unsettled_repo_idx" ON "git_operation" USING btree ("repository_id") WHERE "git_operation"."execution" in ('executing','unknown');
--> statement-breakpoint
CREATE INDEX "git_operation_thread_idx" ON "git_operation" USING btree ("thread_id","created_at");
--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_approval_wait_ms_check" CHECK ("run"."approval_wait_ms" >= 0);
