import { z } from "zod";
import { SegmentTarget } from "./targets.js";

/** Visit state machine — see DESIGN.md §5. */
export const VisitStatus = z.enum([
  "draft",
  "queued",
  "processing",
  "needs_input",
  "assessed",
  "reviewed",
  "reported",
]);
export type VisitStatus = z.infer<typeof VisitStatus>;

export const AgentRunStatus = z.enum(["running", "finished", "needs_input", "failed"]);
export type AgentRunStatus = z.infer<typeof AgentRunStatus>;

/** `rejection`: the agent rejected a SAM segment in verify_segments (payload: RejectionPayload). */
export const AgentStepKind = z.enum(["model", "tool_call", "tool_result", "rejection", "error"]);
export type AgentStepKind = z.infer<typeof AgentStepKind>;

export interface RejectionPayload {
  photo_id: number;
  segment_id: number;
  target: string;
  reason: string;
}

/** One row of agent_steps; also the payload of each SSE event on /visits/:id/trace. */
export const AgentStep = z.object({
  id: z.number().int(),
  runId: z.number().int(),
  idx: z.number().int(),
  kind: AgentStepKind,
  name: z.string().nullable(),
  payload: z.unknown(),
  createdAt: z.string(),
});
export type AgentStep = z.infer<typeof AgentStep>;

export const ScaleReference = z.enum(["a4", "tape_1m", "brick"]);
export type ScaleReference = z.infer<typeof ScaleReference>;

// Tool argument schemas. Every tool call is validated against these before its handler runs.
export const ToolArgs = {
  list_boq_items: z.object({ zone_id: z.number().int().optional() }),
  list_photos: z.object({ zone_id: z.number().int().optional() }),
  view_photo: z.object({ photo_id: z.number().int(), with_masks: z.boolean().optional() }),
  segment_photo: z.object({
    photo_id: z.number().int(),
    targets: z.array(SegmentTarget).min(1).max(SegmentTarget.options.length),
  }),
  verify_segments: z.object({
    photo_id: z.number().int(),
    decisions: z
      .array(
        z.object({
          segment_id: z.number().int(),
          keep: z.boolean(),
          reason: z.string().describe("Required when keep=false, e.g. 'scaffolding pole'."),
        }),
      )
      .min(1),
  }),
  measure: z.object({
    photo_id: z.number().int(),
    segment_ids: z.array(z.number().int()).min(1),
    reference: ScaleReference,
  }),
  get_previous_assessment: z.object({ boq_item_id: z.number().int() }),
  record_assessment: z.object({
    boq_item_id: z.number().int(),
    percent_complete: z.number().min(0).max(100),
    qty_done: z.number().nonnegative().optional(),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1),
    evidence: z
      .array(z.object({ photo_id: z.number().int(), segment_ids: z.array(z.number().int()) }))
      .min(1),
    deviation: z.string().optional(),
  }),
  request_photo: z.object({
    zone_id: z.number().int(),
    boq_item_id: z.number().int().optional(),
    instruction: z.string().min(10),
    reason: z.string().min(1),
  }),
  finish: z.object({ summary: z.string().min(1) }),
} as const;

export type ToolName = keyof typeof ToolArgs;
export const TOOL_NAMES = Object.keys(ToolArgs) as ToolName[];
