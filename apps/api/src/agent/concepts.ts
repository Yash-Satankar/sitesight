import type { MeasureMode, SegmentTarget } from "@sitesight/shared";
import { segment, type Segment } from "../meta/sam.js";
import { mergeOverlapping } from "../meta/masks.js";

/**
 * Which SAM prompts to run for each measure target, chosen from the day-1 spike (samples/out/run-*.json).
 * Several prompts per target are all run and their instances merged, because each variant catches
 * walls/columns the other misses. Rebar and slab are not segmented (too unreliable in the spike):
 * those BOQ items use measure_mode "visual_only".
 */
export interface TargetConfig {
  prompts: string[];
  /** The BOQ measure_mode this target supports. */
  measureMode: Exclude<MeasureMode, "visual_only">;
  description: string;
}

export const SEGMENT_TARGETS: Record<SegmentTarget, TargetConfig> = {
  column: { prompts: ["concrete column"], measureMode: "count", description: "RCC / concrete columns" },
  brickwork: { prompts: ["exposed brick wall", "brickwork"], measureMode: "area", description: "brick masonry walls" },
};

/** Instances from different prompt variants overlapping more than this are the same object. */
export const MERGE_IOU_THRESHOLD = 0.5;

/** What the agent must reject in verify_segments (also used in the system prompt). */
export const REJECT_EXAMPLES = [
  "scaffolding poles and props",
  "trees and vegetation",
  "steel columns or steel sections",
  "safety nets, tarps and sheets",
  "anything that is not part of the structure being assessed (neighbouring buildings, stacked material, vehicles)",
];

/**
 * Segment a photo for several targets in one batch: all prompt variants go to SAM together
 * (concurrent, budget-checked per request), then each target's instances are merged by mask IoU,
 * keeping the higher score. Returned segments are labelled with the target name, not the prompt.
 */
export async function segmentTargets(
  image: Buffer,
  targets: SegmentTarget[],
  opts: { runId?: number } = {},
): Promise<Map<SegmentTarget, Segment[]>> {
  const prompts = [...new Set(targets.flatMap((t) => SEGMENT_TARGETS[t].prompts))];
  const raw = await segment(image, prompts, opts);

  const result = new Map<SegmentTarget, Segment[]>();
  for (const target of targets) {
    const mine = raw.filter((s) => SEGMENT_TARGETS[target].prompts.includes(s.concept));
    const merged = SEGMENT_TARGETS[target].prompts.length > 1 ? await mergeOverlapping(mine, MERGE_IOU_THRESHOLD) : mine;
    result.set(
      target,
      merged.map((s, i) => ({ ...s, concept: target, instanceIdx: i })),
    );
  }
  return result;
}
