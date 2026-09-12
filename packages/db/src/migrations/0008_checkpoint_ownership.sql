ALTER TABLE "run" ADD COLUMN "execution_owner_attempt_id" text;
--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "execution_owner_token" uuid;
--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "execution_owner_generation" integer;
--> statement-breakpoint
CREATE TABLE "run_execution_owner" (
	"run_id" uuid NOT NULL,
	"attempt_id" text NOT NULL,
	"token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"generation" integer NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_execution_owner_run_id_attempt_id_pk" PRIMARY KEY("run_id","attempt_id"),
	CONSTRAINT "run_execution_owner_token_unique" UNIQUE("token"),
	CONSTRAINT "run_execution_owner_generation_check" CHECK ("generation" >= 1)
);
--> statement-breakpoint
ALTER TABLE "run_execution_owner" ADD CONSTRAINT "run_execution_owner_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE cascade ON UPDATE no action;
