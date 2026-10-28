ALTER TABLE "boq_items" ADD COLUMN "segment_targets" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "segments" ADD COLUMN "verified" boolean;--> statement-breakpoint
ALTER TABLE "segments" ADD COLUMN "reject_reason" text;