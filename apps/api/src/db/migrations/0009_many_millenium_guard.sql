CREATE TABLE "spend_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"project_id" integer,
	"visit_id" integer,
	"cost_usd" numeric NOT NULL
);
--> statement-breakpoint
CREATE INDEX "spend_ledger_at_idx" ON "spend_ledger" USING btree ("at");--> statement-breakpoint
-- Backfill: existing agent-run and drawing-import costs, one row per run/import, at its start time.
INSERT INTO "spend_ledger" ("at", "kind", "project_id", "visit_id", "cost_usd")
SELECT r."started_at", 'agent_run', v."project_id", r."visit_id", r."cost_usd"
FROM "agent_runs" r JOIN "visits" v ON v."id" = r."visit_id"
WHERE r."cost_usd" > 0;--> statement-breakpoint
INSERT INTO "spend_ledger" ("at", "kind", "project_id", "visit_id", "cost_usd")
SELECT d."created_at", 'drawing_import', d."project_id", NULL, d."cost_usd"
FROM "drawing_imports" d
WHERE d."cost_usd" > 0;
