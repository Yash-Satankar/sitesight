CREATE TABLE "panel_measurements" (
	"id" serial PRIMARY KEY NOT NULL,
	"visit_id" integer NOT NULL,
	"photo_id" integer NOT NULL,
	"run_id" integer,
	"target_segment_ids" integer[] NOT NULL,
	"panel" jsonb NOT NULL,
	"panel_area_px" integer NOT NULL,
	"covered_area_px" integer NOT NULL,
	"fraction" real NOT NULL,
	"clipped" boolean NOT NULL,
	"warnings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "boq_items" ADD COLUMN "panel_planned_qty" numeric;--> statement-breakpoint
ALTER TABLE "panel_measurements" ADD CONSTRAINT "panel_measurements_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panel_measurements" ADD CONSTRAINT "panel_measurements_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panel_measurements" ADD CONSTRAINT "panel_measurements_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;