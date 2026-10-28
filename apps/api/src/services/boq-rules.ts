import type { BoqItemInput } from "@sitesight/shared";
import { SEGMENT_TARGETS } from "../agent/concepts.js";

/**
 * A BOQ item can only be measured from photos through a segment target whose mode matches:
 * count ↔ column, area ↔ brickwork. Everything else is visual_only with no targets.
 * Returns the problem for an inconsistent item, or null.
 */
export function boqItemProblem(item: BoqItemInput): string | null {
  const mismatched = item.segmentTargets.filter((t) => SEGMENT_TARGETS[t].measureMode !== item.measureMode);
  if (item.measureMode === "visual_only" && item.segmentTargets.length) {
    return `visual_only items must not have segment targets (got ${item.segmentTargets.join(", ")})`;
  }
  if (item.measureMode !== "visual_only" && !item.segmentTargets.length) {
    return `${item.measureMode} items need a segment target; use visual_only if it cannot be segmented`;
  }
  if (mismatched.length) return `segment target ${mismatched.join(", ")} cannot be measured as ${item.measureMode}`;
  return null;
}

/** Make a parsed item consistent: keep matching targets, otherwise fall back to visual_only. */
export function normalizeBoqItem(item: BoqItemInput): { item: BoqItemInput; warning: string | null } {
  const problem = boqItemProblem(item);
  if (!problem) return { item, warning: null };
  const matching = item.segmentTargets.filter((t) => SEGMENT_TARGETS[t].measureMode === item.measureMode);
  const fixed: BoqItemInput =
    item.measureMode !== "visual_only" && matching.length
      ? { ...item, segmentTargets: matching }
      : { ...item, measureMode: "visual_only", segmentTargets: [] };
  return { item: fixed, warning: `${item.code}: ${problem}. Set to ${fixed.measureMode}.` };
}
