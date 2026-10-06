ALTER TABLE "thread" ADD COLUMN "preview_slug" text DEFAULT replace(gen_random_uuid()::text, '-', '') NOT NULL;--> statement-breakpoint
ALTER TABLE "thread" ADD COLUMN "browser_owner" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "question_request" ADD COLUMN "browser_handoff" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_preview_slug_unique" UNIQUE("preview_slug");--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_browser_owner_check" CHECK ("thread"."browser_owner" in ('agent','user'));