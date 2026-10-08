CREATE TABLE "message_delivery" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"target_run_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"accepted_as_pending" boolean NOT NULL,
	"consumed_entry_id" text,
	"original_prompt" text NOT NULL,
	"model_selection" jsonb NOT NULL,
	"sequence" integer NOT NULL,
	"max_active_runs" integer NOT NULL,
	CONSTRAINT "message_delivery_mode_check" CHECK ("message_delivery"."mode" in ('steer', 'queue')),
	CONSTRAINT "message_delivery_state_check" CHECK ("message_delivery"."state" in ('pending', 'consumed', 'started', 'removed')),
	CONSTRAINT "message_delivery_sequence_check" CHECK ("message_delivery"."sequence" > 0),
	CONSTRAINT "message_delivery_admission_check" CHECK ("message_delivery"."max_active_runs" > 0)
);
--> statement-breakpoint
ALTER TABLE "message_delivery" ADD CONSTRAINT "message_delivery_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_delivery" ADD CONSTRAINT "message_delivery_target_run_id_run_id_fk" FOREIGN KEY ("target_run_id") REFERENCES "public"."run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_delivery_pending_idx" ON "message_delivery" USING btree ("target_run_id","state","sequence");