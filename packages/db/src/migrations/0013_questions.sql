CREATE TABLE "question_request" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"questions" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"answers" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "question_request_state_check" CHECK ("question_request"."state" in ('pending','answered','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "question_wait_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "question_wait_ms" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "question_request" ADD CONSTRAINT "question_request_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_request" ADD CONSTRAINT "question_request_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_request" ADD CONSTRAINT "question_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "question_request_tool_idx" ON "question_request" USING btree ("run_id","tool_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "question_request_pending_run_idx" ON "question_request" USING btree ("run_id") WHERE "question_request"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "question_request_thread_idx" ON "question_request" USING btree ("thread_id","created_at");--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_question_wait_ms_check" CHECK ("run"."question_wait_ms" >= 0);