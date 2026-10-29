CREATE TABLE "drawing_imports" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"file_name" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"cost_usd" numeric DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"proposal" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drawing_pages" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"import_id" integer NOT NULL,
	"page_no" integer NOT NULL,
	"storage_key" text NOT NULL,
	"thumb_key" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"title_guess" text,
	"sheet_type" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"classification" jsonb,
	"extraction" jsonb,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "boq_items" ADD COLUMN "drawing_source" text;--> statement-breakpoint
ALTER TABLE "drawing_imports" ADD CONSTRAINT "drawing_imports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_pages" ADD CONSTRAINT "drawing_pages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_pages" ADD CONSTRAINT "drawing_pages_import_id_drawing_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."drawing_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drawing_pages_import_idx" ON "drawing_pages" USING btree ("import_id","page_no");