import { z } from "zod";
import { BoqItem, BoqItemInput } from "./boq.js";
import { Assessment, AskBack, AssessmentStatus, EvidenceBasis } from "./assessment.js";
import { VisitStatus } from "./agent.js";
import { ProgressRow } from "../progress.js";

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

/** GET /projects rows: a project plus the numbers its card shows. */
export const ProjectListItem = Project.extend({
  /**
   * Planned-qty-weighted average of each BOQ item's latest confirmed (accepted/edited) percent; items without one
   * count as 0. Null when the project has no BOQ items with a planned quantity.
   */
  overallPercent: z.number().nullable(),
  /** Confirmed items counted in overallPercent whose latest assessment is inferred (not billable). */
  inferredItems: z.number().int(),
  lastVisitDate: z.string().nullable(),
  /** Photo requests still open across the project's visits. */
  openAskBacks: z.number().int(),
});
export type ProjectListItem = z.infer<typeof ProjectListItem>;

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

/** One assessment of a BOQ item, as summarised on the project page. */
export const ItemAssessmentSummary = z.object({
  assessmentId: z.number().int(),
  visitId: z.number().int(),
  visitDate: z.string(),
  percentComplete: z.number(),
  stageReached: z.string().nullable(),
  basis: EvidenceBasis,
  status: AssessmentStatus,
});
export type ItemAssessmentSummary = z.infer<typeof ItemAssessmentSummary>;

export const ProjectDetail = Project.extend({
  zones: z.array(Zone),
  boqItems: z.array(BoqItem),
  visits: z.array(VisitSummary),
  /** Latest accepted/edited percent_complete, keyed by boq item id. */
  progress: z.record(z.string(), z.number()),
  /**
   * Per BOQ item id: `confirmed` is the assessment behind `progress` (latest accepted/edited); `latest` is the newest
   * assessment of any status (may be a proposed one still to review). Items never assessed are absent.
   */
  itemAssessments: z.record(
    z.string(),
    z.object({ confirmed: ItemAssessmentSummary.nullable(), latest: ItemAssessmentSummary }),
  ),
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

// uploadUrl is absolute (R2) or relative to the API (local storage mode: "/storage/…").
export const PresignResponse = z.object({ uploadUrl: z.string().min(1), storageKey: z.string() });
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

/** Item counts for the visit summary card, and progress since the previous assessed visit. */
export const VisitProgress = z.object({
  totalItems: z.number().int(),
  /** Items with an observed assessment in this visit. */
  assessed: z.number().int(),
  /** Items assessed by inference only (not billed). */
  inferred: z.number().int(),
  /** Items without an assessment that have an open photo request (any visit of the project). */
  awaitingPhoto: z.number().int(),
  notAssessed: z.number().int(),
  previousVisit: z.object({ id: z.number().int(), visitDate: z.string() }).nullable(),
  /** Per-item comparison with previousVisit; empty when there is none. */
  sinceLastVisit: z.array(ProgressRow),
});
export type VisitProgress = z.infer<typeof VisitProgress>;

export const VisitDetail = VisitSummary.extend({
  photos: z.array(Photo),
  assessments: z.array(Assessment),
  askBacks: z.array(AskBack),
  earlierOpenAskBacks: z.array(EarlierAskBack),
  summary: VisitProgress,
});
export type VisitDetail = z.infer<typeof VisitDetail>;

// ---- Ask-backs & review ----
export const FulfilAskBackBody = z.object({ photoId: z.number().int() });
export type FulfilAskBackBody = z.infer<typeof FulfilAskBackBody>;

export const ReviewAssessmentBody = z.object({
  action: z.enum(["accept", "edit"]),
  percentComplete: z.number().min(0).max(100).optional(),
  qtyDone: z.number().nonnegative().nullable().optional(),
  engineerNote: z.string().optional(),
});
/** Undo an acceptance/edit: back to "proposed". Refused once a report has been generated since the review. */
export const RevertAssessmentBody = z.object({ status: z.literal("proposed") }).strict();
export const PatchAssessmentBody = z.union([ReviewAssessmentBody, RevertAssessmentBody]);
export type PatchAssessmentBody = z.infer<typeof PatchAssessmentBody>;

export const ReportResponse = z.object({ reportId: z.number().int(), downloadUrl: z.string() });
export type ReportResponse = z.infer<typeof ReportResponse>;
