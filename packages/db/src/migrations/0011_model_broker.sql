
CREATE TABLE "model_credential" (
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"encrypted" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_credential_user_id_provider_pk" PRIMARY KEY("user_id","provider")
);

--> statement-breakpoint

ALTER TABLE "run" ADD COLUMN "model_selection" jsonb;
--> statement-breakpoint

ALTER TABLE "model_credential" ADD CONSTRAINT "model_credential_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
