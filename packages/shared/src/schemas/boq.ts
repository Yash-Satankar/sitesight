import { z } from "zod";
import { SegmentTarget } from "./targets.js";

/** `lot`: a whole item tracked by % only (planned_qty 1). */
export const Unit = z.enum(["nos", "m2", "m3", "rmt", "kg", "lot"]);
export type Unit = z.infer<typeof Unit>;

export const MeasureMode = z.enum(["count", "area", "visual_only"]);
export type MeasureMode = z.infer<typeof MeasureMode>;

export const BoqStage = z.object({ name: z.string().trim().min(1), weight: z.number().positive().max(1) });
export type BoqStage = z.infer<typeof BoqStage>;

/** Percent complete once `stageReached` is done: cumulative weight up to and including it. "none" → 0. */
export function stagePercent(stages: BoqStage[], stageReached: string): number | null {
  if (stageReached === "none") return 0;
  const i = stages.findIndex((s) => s.name === stageReached);
  if (i < 0) return null;
  const sum = stages.slice(0, i + 1).reduce((a, s) => a + s.weight, 0);
  return Math.round(sum * 10000) / 100; // 2 dp
}

/** A BOQ line item as produced by the parser or edited by the engineer. */
export const BoqItemInput = z.object({
  zoneId: z.number().int().nullable().default(null),
  code: z.string().min(1),
  description: z.string().min(1),
  unit: Unit,
  plannedQty: z.number().nonnegative(),
  measureMode: MeasureMode,
  /** What SAM segments for this item. count/area items need one; visual_only items have []. */
  segmentTargets: z.array(SegmentTarget).max(2).default([]),
  /**
   * Area items only: planned quantity inside one photographed panel (e.g. one brick bay between two columns).
   * Panel measurements compute qty_done = covered fraction × this (or × plannedQty when null).
   */
  panelPlannedQty: z.number().positive().nullable().default(null),
  /**
   * Visual-only items built in stages (e.g. slab: shuttering → reinforcement → concreting). Weights sum to 1
   * (checked in boq-rules). The agent names the latest completed stage; code turns it into a percent.
   */
  stages: z.array(BoqStage).min(2).nullable().default(null),
  sequenceNo: z.number().int().nullable().default(null),
  /** Where the planned quantity comes from on the drawings, e.g. "12 nos per column schedule, p.2" (drawing import). */
  drawingSource: z.string().max(500).nullable().default(null),
});
export type BoqItemInput = z.infer<typeof BoqItemInput>;

export const BoqItem = BoqItemInput.extend({
  id: z.number().int(),
  projectId: z.number().int(),
});
export type BoqItem = z.infer<typeof BoqItem>;

/** What Muse Spark must return when parsing raw BOQ rows. */
export const BoqParseResult = z.object({
  items: z.array(BoqItemInput.omit({ zoneId: true })),
  warnings: z.array(z.string()).default([]),
});
export type BoqParseResult = z.infer<typeof BoqParseResult>;
