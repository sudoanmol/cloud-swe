DROP TABLE "demo_compute_month_allocation" CASCADE;--> statement-breakpoint
DROP TABLE "demo_compute_reservation" CASCADE;--> statement-breakpoint
DROP TABLE "demo_compute_usage" CASCADE;--> statement-breakpoint
DELETE FROM "workspace" WHERE "provider" = 'freestyle';--> statement-breakpoint
ALTER TABLE "workspace" DROP CONSTRAINT "workspace_provider_check";--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_provider_check" CHECK ("workspace"."provider" in ('docker', 'modal'));
