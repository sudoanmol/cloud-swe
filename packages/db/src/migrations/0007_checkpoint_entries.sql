CREATE TABLE "agent_checkpoint_entry" (
	"checkpoint_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"content" jsonb NOT NULL,
	CONSTRAINT "agent_checkpoint_entry_checkpoint_id_ordinal_pk" PRIMARY KEY("checkpoint_id","ordinal"),
	CONSTRAINT "agent_checkpoint_entry_ordinal_check" CHECK ("agent_checkpoint_entry"."ordinal" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_checkpoint_entry" ADD CONSTRAINT "agent_checkpoint_entry_checkpoint_id_agent_checkpoint_id_fk" FOREIGN KEY ("checkpoint_id") REFERENCES "public"."agent_checkpoint"("id") ON DELETE cascade ON UPDATE no action;