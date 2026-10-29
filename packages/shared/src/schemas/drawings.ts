import { z } from "zod";
import { BoqItemInput } from "./boq.js";

// ---- What Muse Spark returns ----

export const SheetType = z.enum([
  "column_layout",
  "footing_layout",
  "footing_column_schedule",
  "plinth_beam",
  "slab_plan",
  "beam_schedule",
  "floor_plan",
  "electrical",
  "drainage",
  "door_window",
  "other",
]);
export type SheetType = z.infer<typeof SheetType>;

/** Sheets that go to extraction. */
export const STRUCTURAL_SHEETS: readonly SheetType[] = [
  "column_layout",
  "footing_layout",
  "footing_column_schedule",
  "plinth_beam",
  "slab_plan",
  "beam_schedule",
];

/** One call per page. Floor plans also say whether masonry walls are drawn (for the brickwork item). */
export const PageClassification = z.object({
  sheet_type: SheetType,
  title: z.string().max(200),
  notes: z.string().max(500).default(""),
  shows_masonry_walls: z.boolean().default(false),
});
export type PageClassification = z.infer<typeof PageClassification>;

const evidence = {
  /** Text copied from the drawing that supports the value (schedule row, label, note). */
  evidence_text: z.string().min(1).max(300),
  confidence: z.number().min(0).max(1),
};
const floor = z.string().max(40).nullable().default(null);

/**
 * Per structural sheet. Only what is printed on the sheet: no assumptions, no computed totals.
 * `count` fields are null when the sheet does not state them.
 */
export const SheetExtraction = z.object({
  /** Column schedule rows (marks, size, number of columns of that mark if the schedule states it). */
  columns: z
    .array(z.object({ mark: z.string().min(1).max(20), size_text: z.string().max(40), count: z.number().int().positive().nullable(), floor, ...evidence }))
    .default([]),
  /** Footing schedule rows; dimensions in mm as printed (convert feet/inches to mm). */
  footings: z
    .array(
      z.object({
        mark: z.string().min(1).max(20),
        length_mm: z.number().positive().nullable(),
        breadth_mm: z.number().positive().nullable(),
        depth_mm: z.number().positive().nullable(),
        size_text: z.string().max(60),
        count: z.number().int().positive().nullable(),
        ...evidence,
      }),
    )
    .default([]),
  beams: z
    .array(
      z.object({
        mark: z.string().min(1).max(20),
        size_text: z.string().max(40),
        kind: z.enum(["plinth", "floor", "roof", "lintel", "other"]),
        ...evidence,
      }),
    )
    .default([]),
  /** Slabs; area_m2 and thickness_mm only when printed on the sheet (convert units, never estimate). */
  slabs: z
    .array(
      z.object({
        mark: z.string().min(1).max(40),
        floor,
        thickness_mm: z.number().positive().nullable(),
        area_m2: z.number().positive().nullable(),
        ...evidence,
      }),
    )
    .default([]),
  /** Counts read off layout plans by counting labelled instances, e.g. how many "C2" on the column layout. */
  layout_counts: z
    .array(z.object({ element: z.enum(["column", "footing"]), mark: z.string().min(1).max(20), count: z.number().int().nonnegative(), floor, ...evidence }))
    .default([]),
  notes: z.array(z.string().max(300)).default([]),
});
export type SheetExtraction = z.infer<typeof SheetExtraction>;

// ---- Proposal assembled by code ----

export const DrawingSource = z.object({
  page: z.number().int(),
  sheet: z.string(),
  evidence_text: z.string(),
  confidence: z.number(),
});
export type DrawingSource = z.infer<typeof DrawingSource>;

export const DrawingDiscrepancy = z.object({
  element: z.enum(["column", "footing"]),
  mark: z.string(),
  floor: z.string().nullable(),
  scheduleCount: z.number().int(),
  layoutCount: z.number().int(),
  schedulePage: z.number().int(),
  layoutPage: z.number().int(),
  message: z.string(),
});
export type DrawingDiscrepancy = z.infer<typeof DrawingDiscrepancy>;

export const ProposedBoqItem = BoqItemInput.extend({
  key: z.string(),
  /** Quantity not supported by the drawings (or contradictory): the engineer must enter it. plannedQty is 0. */
  needsInput: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  sources: z.array(DrawingSource),
});
export type ProposedBoqItem = z.infer<typeof ProposedBoqItem>;

export const BoqProposal = z.object({
  items: z.array(ProposedBoqItem),
  discrepancies: z.array(DrawingDiscrepancy),
  warnings: z.array(z.string()),
});
export type BoqProposal = z.infer<typeof BoqProposal>;

// ---- API ----

export const DrawingImportStatus = z.enum(["queued", "processing", "done", "cost_limit", "failed"]);
export const DrawingPageStatus = z.enum(["pending", "classified", "extracted", "skipped", "failed"]);

export const DrawingPage = z.object({
  id: z.number().int(),
  pageNo: z.number().int(),
  status: DrawingPageStatus,
  sheetType: SheetType.nullable(),
  titleGuess: z.string().nullable(),
  width: z.number().int(),
  height: z.number().int(),
  error: z.string().nullable(),
  /** Presigned (or API-relative in local storage mode) URLs. */
  imageUrl: z.string(),
  thumbUrl: z.string(),
});
export type DrawingPage = z.infer<typeof DrawingPage>;

export const DrawingImport = z.object({
  id: z.number().int(),
  projectId: z.number().int(),
  fileName: z.string(),
  status: DrawingImportStatus,
  costUsd: z.number(),
  costLimitUsd: z.number(),
  error: z.string().nullable(),
  pages: z.array(DrawingPage),
  proposal: BoqProposal.nullable(),
});
export type DrawingImport = z.infer<typeof DrawingImport>;
