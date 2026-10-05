ALTER TABLE "demo_turn" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "demo_turn" CASCADE;--> statement-breakpoint
ALTER TABLE "run" DROP CONSTRAINT "run_access_policy_check";--> statement-breakpoint
ALTER TABLE "run" DROP COLUMN "access_policy";