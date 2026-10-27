import { z } from "zod";

export const AssessmentStatus = z.enum(["proposed", "accepted", "edited"]);
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
  evidence: z.array(Evidence),
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
