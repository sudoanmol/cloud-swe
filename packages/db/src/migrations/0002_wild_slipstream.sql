ALTER TABLE "message" ADD CONSTRAINT "message_request_kind_check" CHECK ("message"."request_kind" in ('initial', 'followup'));--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_status_check" CHECK ("run"."status" in ('queued', 'running', 'completed', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_event_sequence_check" CHECK ("thread"."event_sequence" >= 0);--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_state_check" CHECK ("workspace"."state" in ('provisioning', 'running', 'paused', 'deleted', 'failed'));