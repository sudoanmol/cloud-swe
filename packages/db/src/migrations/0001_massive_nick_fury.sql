ALTER TABLE "message" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "request_kind" text DEFAULT 'followup' NOT NULL;--> statement-breakpoint
