CREATE TABLE "environment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environment_revision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"environment_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"encrypted" text NOT NULL,
	"entries" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environment_revision_number_check" CHECK ("environment_revision"."number" >= 1)
);
--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "environment_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "thread" ADD COLUMN "environment_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "environment" ADD CONSTRAINT "environment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_revision" ADD CONSTRAINT "environment_revision_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "environment_user_name_idx" ON "environment" USING btree ("user_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "environment_revision_number_idx" ON "environment_revision" USING btree ("environment_id","number");--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_environment_revision_id_environment_revision_id_fk" FOREIGN KEY ("environment_revision_id") REFERENCES "public"."environment_revision"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_environment_revision_id_environment_revision_id_fk" FOREIGN KEY ("environment_revision_id") REFERENCES "public"."environment_revision"("id") ON DELETE set null ON UPDATE no action;