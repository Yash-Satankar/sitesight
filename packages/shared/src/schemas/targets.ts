import { z } from "zod";

/**
 * Things SAM is allowed to segment. Each maps to tuned prompt variants in apps/api/src/agent/concepts.ts.
 * Anything else (rebar, slab, plaster, openings, …) is assessed visually: measure_mode "visual_only".
 */
export const SegmentTarget = z.enum(["column", "brickwork"]);
export type SegmentTarget = z.infer<typeof SegmentTarget>;
