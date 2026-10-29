ALTER TABLE "assessments" ADD COLUMN "stage_reached" text;--> statement-breakpoint
ALTER TABLE "boq_items" ADD COLUMN "stages" jsonb;