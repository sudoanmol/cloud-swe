CREATE TABLE "attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"message_id" uuid,
	"ordinal" integer,
	"filename" text NOT NULL,
	"detected_mime_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"classification" text NOT NULL,
	"state" text DEFAULT 'uploading' NOT NULL,
	"original_object_key" text,
	"original_sha256" text,
	"original_size" integer,
	"model_object_key" text,
	"model_sha256" text,
	"model_mime_type" text,
	"model_size" integer,
	"model_width" integer,
	"model_height" integer,
	"storage_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_ordinal_check" CHECK ("attachment"."ordinal" is null or "attachment"."ordinal" >= 0),
	CONSTRAINT "attachment_original_size_check" CHECK ("attachment"."original_size" is null or "attachment"."original_size" >= 0),
	CONSTRAINT "attachment_model_size_check" CHECK ("attachment"."model_size" is null or "attachment"."model_size" >= 0),
	CONSTRAINT "attachment_storage_bytes_check" CHECK ("attachment"."storage_bytes" >= 0),
	CONSTRAINT "attachment_classification_check" CHECK ("attachment"."classification" in ('image', 'file')),
	CONSTRAINT "attachment_state_check" CHECK ("attachment"."state" in ('uploading', 'ready', 'failed', 'deleting')),
	CONSTRAINT "attachment_binding_check" CHECK (("attachment"."message_id" is null and "attachment"."ordinal" is null) or ("attachment"."message_id" is not null and "attachment"."ordinal" is not null))
);
--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachment_user_created_idx" ON "attachment" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "attachment_message_ordinal_idx" ON "attachment" USING btree ("message_id","ordinal");