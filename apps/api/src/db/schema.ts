import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  numeric,
  real,
  timestamp,
  jsonb,
  date,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  locationLabel: text("location_label").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const zones = pgTable("zones", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const boqItems = pgTable("boq_items", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  zoneId: integer("zone_id").references(() => zones.id, { onDelete: "set null" }),
  code: text("code").notNull(),
  description: text("description").notNull(),
  unit: text("unit", { enum: ["nos", "m2", "m3", "rmt", "kg"] }).notNull(),
  plannedQty: numeric("planned_qty", { mode: "number" }).notNull(),
  measureMode: text("measure_mode", { enum: ["count", "area", "visual_only"] }).notNull(),
  segmentTargets: text("segment_targets", { enum: ["column", "brickwork"] }).array().notNull().default([]),
  // Area items: planned qty inside one photographed panel; qty_done = panel fraction × this (else × planned_qty).
  panelPlannedQty: numeric("panel_planned_qty", { mode: "number" }),
  sequenceNo: integer("sequence_no"),
});

export const visits = pgTable("visits", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  visitDate: date("visit_date").notNull().defaultNow(),
  status: text("status", {
    enum: ["draft", "queued", "processing", "needs_input", "assessed", "reviewed", "reported"],
  })
    .notNull()
    .default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const askBacks = pgTable("ask_backs", {
  id: serial("id").primaryKey(),
  visitId: integer("visit_id")
    .notNull()
    .references(() => visits.id, { onDelete: "cascade" }),
  zoneId: integer("zone_id")
    .notNull()
    .references(() => zones.id),
  boqItemId: integer("boq_item_id").references(() => boqItems.id, { onDelete: "set null" }),
  instruction: text("instruction").notNull(),
  reason: text("reason").notNull(),
  status: text("status", { enum: ["open", "fulfilled", "skipped"] })
    .notNull()
    .default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const photos = pgTable(
  "photos",
  {
    id: serial("id").primaryKey(),
    visitId: integer("visit_id")
      .notNull()
      .references(() => visits.id, { onDelete: "cascade" }),
    zoneId: integer("zone_id")
      .notNull()
      .references(() => zones.id),
    storageKey: text("storage_key").notNull(),
    // Dimensions of the normalised image (EXIF-rotated, long edge <= MAX_IMAGE_EDGE_PX).
    // SAM masks and model inputs all use this coordinate space.
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    voiceNoteKey: text("voice_note_key"),
    transcript: text("transcript"),
    askBackId: integer("ask_back_id").references(() => askBacks.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("photos_visit_idx").on(t.visitId)],
);

export const segments = pgTable(
  "segments",
  {
    id: serial("id").primaryKey(),
    photoId: integer("photo_id")
      .notNull()
      .references(() => photos.id, { onDelete: "cascade" }),
    concept: text("concept").notNull(),
    instanceIdx: integer("instance_idx").notNull(),
    maskKey: text("mask_key").notNull(),
    bbox: jsonb("bbox").$type<[number, number, number, number]>().notNull(), // [x, y, w, h] px
    areaPx: integer("area_px").notNull(),
    score: real("score").notNull(),
    // Set by the agent via verify_segments. null = not yet checked; measure only accepts true.
    verified: boolean("verified"),
    rejectReason: text("reject_reason"),
  },
  (t) => [index("segments_photo_concept_idx").on(t.photoId, t.concept)],
);

/**
 * Records that SAM was already run for (photo, concept), including runs that found
 * zero instances, so the agent never pays twice. Not in DESIGN.md §4; needed for the §6 cache.
 */
export const segmentQueries = pgTable(
  "segment_queries",
  {
    photoId: integer("photo_id")
      .notNull()
      .references(() => photos.id, { onDelete: "cascade" }),
    concept: text("concept").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.photoId, t.concept] })],
);

/**
 * Result of measure(mode='panel'). record_assessment reads `fraction` from here by id, so the
 * quantity is computed by code from a stored measurement, never typed in by the model.
 */
export const panelMeasurements = pgTable("panel_measurements", {
  id: serial("id").primaryKey(),
  visitId: integer("visit_id")
    .notNull()
    .references(() => visits.id, { onDelete: "cascade" }),
  photoId: integer("photo_id")
    .notNull()
    .references(() => photos.id, { onDelete: "cascade" }),
  runId: integer("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  targetSegmentIds: integer("target_segment_ids").array().notNull(),
  panel: jsonb("panel").notNull(), // the PanelSpecArg as given
  panelAreaPx: integer("panel_area_px").notNull(),
  coveredAreaPx: integer("covered_area_px").notNull(),
  fraction: real("fraction").notNull(),
  clipped: boolean("clipped").notNull(),
  warnings: jsonb("warnings").$type<string[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const assessments = pgTable(
  "assessments",
  {
    id: serial("id").primaryKey(),
    visitId: integer("visit_id")
      .notNull()
      .references(() => visits.id, { onDelete: "cascade" }),
    boqItemId: integer("boq_item_id")
      .notNull()
      .references(() => boqItems.id, { onDelete: "cascade" }),
    percentComplete: real("percent_complete").notNull(),
    qtyDone: numeric("qty_done", { mode: "number" }),
    confidence: real("confidence").notNull(),
    rationale: text("rationale").notNull(),
    deviation: text("deviation"),
    status: text("status", { enum: ["proposed", "accepted", "edited"] })
      .notNull()
      .default("proposed"),
    engineerNote: text("engineer_note"),
  },
  (t) => [uniqueIndex("assessments_visit_item_uq").on(t.visitId, t.boqItemId)],
);

export const assessmentEvidence = pgTable(
  "assessment_evidence",
  {
    assessmentId: integer("assessment_id")
      .notNull()
      .references(() => assessments.id, { onDelete: "cascade" }),
    photoId: integer("photo_id")
      .notNull()
      .references(() => photos.id, { onDelete: "cascade" }),
    segmentIds: integer("segment_ids").array().notNull().default([]),
  },
  (t) => [primaryKey({ columns: [t.assessmentId, t.photoId] })],
);

export const agentRuns = pgTable("agent_runs", {
  id: serial("id").primaryKey(),
  visitId: integer("visit_id")
    .notNull()
    .references(() => visits.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["running", "finished", "needs_input", "failed"] })
    .notNull()
    .default("running"),
  steps: integer("steps").notNull().default(0),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costUsd: numeric("cost_usd", { mode: "number" }).notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  error: text("error"),
});

export const agentSteps = pgTable(
  "agent_steps",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    kind: text("kind", { enum: ["model", "tool_call", "tool_result", "rejection", "error"] }).notNull(),
    name: text("name"),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_steps_run_idx").on(t.runId, t.idx)],
);

export const jobs = pgTable(
  "jobs",
  {
    id: serial("id").primaryKey(),
    kind: text("kind", { enum: ["agent_run", "transcribe"] }).notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status", { enum: ["pending", "running", "done", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (t) => [index("jobs_pending_idx").on(t.status, t.runAfter)],
);

export const reports = pgTable("reports", {
  id: serial("id").primaryKey(),
  visitId: integer("visit_id")
    .notNull()
    .references(() => visits.id, { onDelete: "cascade" }),
  storageKey: text("storage_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
