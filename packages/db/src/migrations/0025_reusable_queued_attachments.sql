ALTER TABLE "message_delivery" ADD COLUMN "original_attachment_ids" jsonb;
--> statement-breakpoint
UPDATE "message_delivery" AS delivery
SET "original_attachment_ids" = COALESCE((
  SELECT jsonb_agg(attachment.id ORDER BY attachment.ordinal)
  FROM "attachment"
  WHERE attachment.message_id = delivery.message_id
), '[]'::jsonb);
--> statement-breakpoint
ALTER TABLE "message_delivery" ALTER COLUMN "original_attachment_ids" SET NOT NULL;
--> statement-breakpoint
UPDATE "attachment" AS attachment
SET "message_id" = NULL, "ordinal" = NULL, "updated_at" = now()
FROM "message_delivery" AS delivery
WHERE attachment.message_id = delivery.message_id AND delivery.state = 'removed';
