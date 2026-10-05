ALTER TABLE "git_operation" DROP CONSTRAINT "git_operation_run_id_run_id_fk";
--> statement-breakpoint
ALTER TABLE "git_operation" DROP CONSTRAINT "git_operation_thread_id_thread_id_fk";
--> statement-breakpoint
ALTER TABLE "thread" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "git_operation" ADD CONSTRAINT "git_operation_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_operation" ADD CONSTRAINT "git_operation_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;