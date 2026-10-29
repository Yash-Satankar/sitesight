import { z } from "zod";
import { BoqItem, BoqItemInput } from "./boq.js";
import { Assessment, AskBack } from "./assessment.js";
import { VisitStatus } from "./agent.js";

// ---- Projects & zones ----
export const CreateProjectBody = z.object({
  name: z.string().min(1),
  locationLabel: z.string().default(""),
});
export type CreateProjectBody = z.infer<typeof CreateProjectBody>;

export const Project = z.object({
  id: z.number().int(),
  name: z.string(),
  locationLabel: z.string(),
  createdAt: z.string(),
});
export type Project = z.infer<typeof Project>;

export const Zone = z.object({
  id: z.number().int(),
  projectId: z.number().int(),
  name: z.string(),
  sortOrder: z.number().int(),
});
export type Zone = z.infer<typeof Zone>;

export const CreateZoneBody = z.object({
  name: z.string().min(1),
  sortOrder: z.number().int().default(0),
});
export type CreateZoneBody = z.infer<typeof CreateZoneBody>;

export const VisitSummary = z.object({
  id: z.number().int(),
  projectId: z.number().int(),
  visitDate: z.string(),
  status: VisitStatus,
  createdAt: z.string(),
});
export type VisitSummary = z.infer<typeof VisitSummary>;

export const ProjectDetail = Project.extend({
  zones: z.array(Zone),
  boqItems: z.array(BoqItem),
  visits: z.array(VisitSummary),
  /** Latest accepted/edited percent_complete, keyed by boq item id. */
  progress: z.record(z.string(), z.number()),
});
export type ProjectDetail = z.infer<typeof ProjectDetail>;

// ---- BOQ ----
export const ParsedBoqResponse = z.object({
  items: z.array(BoqItemInput),
  warnings: z.array(z.string()),
});
export type ParsedBoqResponse = z.infer<typeof ParsedBoqResponse>;

export const SaveBoqBody = z.object({ items: z.array(BoqItemInput) });
export type SaveBoqBody = z.infer<typeof SaveBoqBody>;

// ---- Visits & photos ----
export const CreateVisitBody = z.object({
  visitDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type CreateVisitBody = z.infer<typeof CreateVisitBody>;

export const PresignBody = z.object({
  contentType: z.string().regex(/^(image|audio)\//),
  kind: z.enum(["photo", "voice"]).default("photo"),
});
export type PresignBody = z.infer<typeof PresignBody>;

export const PresignResponse = z.object({ uploadUrl: z.string().url(), storageKey: z.string() });
export type PresignResponse = z.infer<typeof PresignResponse>;

export const RegisterPhotoBody = z.object({
  zoneId: z.number().int(),
  storageKey: z.string().min(1),
  voiceNoteKey: z.string().optional(),
  askBackId: z.number().int().optional(),
});
export type RegisterPhotoBody = z.infer<typeof RegisterPhotoBody>;

export const Photo = z.object({
  id: z.number().int(),
  visitId: z.number().int(),
  zoneId: z.number().int(),
  storageKey: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  transcript: z.string().nullable(),
  askBackId: z.number().int().nullable(),
  /** Short-lived presigned GET URL, filled in by the API. */
  url: z.string().optional(),
});
export type Photo = z.infer<typeof Photo>;

/** An ask-back still open from an earlier visit of the same project; a photo in this visit can answer it. */
export const EarlierAskBack = AskBack.extend({ visitDate: z.string() });
export type EarlierAskBack = z.infer<typeof EarlierAskBack>;

export const VisitDetail = VisitSummary.extend({
  photos: z.array(Photo),
  assessments: z.array(Assessment),
  askBacks: z.array(AskBack),
  earlierOpenAskBacks: z.array(EarlierAskBack),
});
export type VisitDetail = z.infer<typeof VisitDetail>;

// ---- Ask-backs & review ----
export const FulfilAskBackBody = z.object({ photoId: z.number().int() });
export type FulfilAskBackBody = z.infer<typeof FulfilAskBackBody>;

export const PatchAssessmentBody = z.object({
  action: z.enum(["accept", "edit"]),
  percentComplete: z.number().min(0).max(100).optional(),
  qtyDone: z.number().nonnegative().nullable().optional(),
  engineerNote: z.string().optional(),
});
export type PatchAssessmentBody = z.infer<typeof PatchAssessmentBody>;

export const ReportResponse = z.object({ reportId: z.number().int(), downloadUrl: z.string() });
export type ReportResponse = z.infer<typeof ReportResponse>;
