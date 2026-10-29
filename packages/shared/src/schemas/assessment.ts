import { z } from "zod";

export const AssessmentStatus = z.enum(["proposed", "accepted", "edited"]);

/**
 * observed: the work is visible in this visit's photos. inferred: hidden earlier-sequence work deduced from
 * observed later work (e.g. footings under a cast plinth beam). Inferred quantities are not billable until observed.
 */
export const EvidenceBasis = z.enum(["observed", "inferred"]);
export type EvidenceBasis = z.infer<typeof EvidenceBasis>;
export const INFERRED_STATUS = "inferred — not billable until observed";
export type AssessmentStatus = z.infer<typeof AssessmentStatus>;

export const Evidence = z.object({
  photoId: z.number().int(),
  segmentIds: z.array(z.number().int()).default([]),
});
export type Evidence = z.infer<typeof Evidence>;

export const Assessment = z.object({
  id: z.number().int(),
  visitId: z.number().int(),
  boqItemId: z.number().int(),
  percentComplete: z.number().min(0).max(100),
  qtyDone: z.number().nonnegative().nullable(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  deviation: z.string().nullable(),
  status: AssessmentStatus,
  engineerNote: z.string().nullable(),
  basis: EvidenceBasis,
  /** Staged items: latest completed stage. */
  stageReached: z.string().nullable(),
  evidence: z.array(Evidence),
  /** Panel measurements behind qty_done (area items): drawn on the evidence photo in review. */
  panels: z.array(z.object({ id: z.number().int(), photoId: z.number().int(), fraction: z.number() })),
});
export type Assessment = z.infer<typeof Assessment>;

export const AskBackStatus = z.enum(["open", "fulfilled", "skipped"]);
export type AskBackStatus = z.infer<typeof AskBackStatus>;

export const AskBack = z.object({
  id: z.number().int(),
  visitId: z.number().int(),
  zoneId: z.number().int(),
  boqItemId: z.number().int().nullable(),
  instruction: z.string(),
  reason: z.string(),
  status: AskBackStatus,
});
export type AskBack = z.infer<typeof AskBack>;
