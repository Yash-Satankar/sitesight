import { z } from "zod";
import { SegmentTarget } from "./targets.js";

export const Unit = z.enum(["nos", "m2", "m3", "rmt", "kg"]);
export type Unit = z.infer<typeof Unit>;

export const MeasureMode = z.enum(["count", "area", "visual_only"]);
export type MeasureMode = z.infer<typeof MeasureMode>;

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
  sequenceNo: z.number().int().nullable().default(null),
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
