import type { BoqItemInput } from "@sitesight/shared";
import { SEGMENT_TARGETS } from "../agent/concepts.js";

/**
 * A BOQ item can only be measured from photos through a segment target whose mode matches:
 * count ↔ column, area ↔ brickwork. Everything else is visual_only with no targets.
 * Stages (weights summing to 1) are for visual_only items.
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
  if (item.panelPlannedQty != null && item.measureMode !== "area") return "panel_planned_qty only applies to area items";
  return stagesProblem(item);
}

/** Stage list problems, or null. */
export function stagesProblem(item: Pick<BoqItemInput, "measureMode" | "stages">): string | null {
  const stages = item.stages;
  if (!stages) return null;
  if (item.measureMode !== "visual_only") return "stages only apply to visual_only items";
  if (stages.length < 2) return "stages need at least 2 entries";
  const names = stages.map((s) => s.name.trim().toLowerCase());
  const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (dupes.length) return `stage names must be unique (repeated: ${dupes.join(", ")})`;
  if (names.includes("none")) return 'stage name "none" is reserved (it means no stage completed)';
  const sum = stages.reduce((a, s) => a + s.weight, 0);
  if (Math.abs(sum - 1) > 0.001) return `stage weights must sum to 1 (got ${Math.round(sum * 1000) / 1000})`;
  return null;
}

/** Make a parsed item consistent: keep matching targets, otherwise fall back to visual_only; drop invalid stages. */
export function normalizeBoqItem(item: BoqItemInput): { item: BoqItemInput; warning: string | null } {
  const problem = boqItemProblem(item);
  if (!problem) return { item, warning: null };
  const matching = item.segmentTargets.filter((t) => SEGMENT_TARGETS[t].measureMode === item.measureMode);
  let fixed: BoqItemInput =
    item.measureMode !== "visual_only" && matching.length
      ? { ...item, segmentTargets: matching }
      : { ...item, measureMode: "visual_only", segmentTargets: [] };
  if (fixed.measureMode !== "area") fixed = { ...fixed, panelPlannedQty: null };
  if (stagesProblem(fixed)) fixed = { ...fixed, stages: null };
  return { item: fixed, warning: `${item.code}: ${problem}. Set to ${fixed.measureMode}${fixed.stages ? " with stages" : ""}.` };
}
