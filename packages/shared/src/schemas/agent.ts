import { z } from "zod";
import { SegmentTarget } from "./targets.js";
import { EvidenceBasis } from "./assessment.js";

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

/** `partial`: the step budget ran out before `finish`; recorded assessments are kept. */
export const AgentRunStatus = z.enum(["running", "finished", "needs_input", "partial", "failed"]);
export type AgentRunStatus = z.infer<typeof AgentRunStatus>;

/**
 * `rejection`: the agent rejected a SAM segment in verify_segments (payload: RejectionPayload).
 * `notice`: a message the loop itself sent or decided (nudge, step-budget wrap-up, partial end).
 */
export const AgentStepKind = z.enum(["model", "tool_call", "tool_result", "rejection", "notice", "error"]);
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

/**
 * A wall panel to measure coverage in, in image pixels:
 * - between two verified column segments (x-bounds = inner edges of the column masks) from top_y to bottom_y, or
 * - a 4-point polygon.
 */
export const PanelSpecArg = z.union([
  z
    .object({
      left_column_id: z.number().int(),
      right_column_id: z.number().int(),
      top_y: z.number().describe("Top of the panel in image pixels, e.g. underside of the slab/beam."),
      bottom_y: z.number().describe("Bottom of the panel in image pixels, e.g. floor level."),
    })
    .strict(),
  z
    .object({
      polygon: z
        .array(z.array(z.number()).length(2))
        .length(4)
        .describe("Four [x, y] corners in image pixels, e.g. [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]."),
    })
    .strict(),
]);
export type PanelSpecArg = z.infer<typeof PanelSpecArg>;

// Tool argument schemas. Every tool call is validated against these before its handler runs.
export const ToolArgs = {
  list_boq_items: z.object({ zone_id: z.number().int().optional() }),
  list_photos: z.object({ zone_id: z.number().int().optional() }),
  view_photo: z.object({
    photo_id: z.number().int(),
    with_masks: z.boolean().optional(),
    draw_panel: PanelSpecArg.optional().describe("Overlay this panel to check it before calling measure in panel mode."),
  }),
  segment_photo: z.object({
    photo_id: z.number().int(),
    targets: z.array(SegmentTarget).min(1).max(SegmentTarget.options.length),
  }),
  verify_segments: z.object({
    photo_id: z.number().int(),
    decisions: z
      .array(
        z
          .object({
            segment_id: z.number().int(),
            keep: z.boolean(),
            reason: z
              .string()
              .optional()
              .describe("Required when keep=false (what it actually is, e.g. 'scaffolding pole'). For keeps, what in the image confirms it."),
          })
          .superRefine((d, ctx) => {
            if (!d.keep && !d.reason?.trim()) {
              ctx.addIssue({
                code: "custom",
                path: ["reason"],
                message: "required when keep is false: say what the segment actually is, e.g. 'scaffolding pole'",
              });
            }
          }),
      )
      .min(1)
      .describe("One decision for every unverified segment of this photo, all in this one call."),
  }),
  // Flat object (not a top-level union) so the JSON schema stays a plain object for function calling.
  measure: z
    .object({
      photo_id: z.number().int(),
      mode: z.enum(["panel", "reference"]).describe("panel: fraction of a wall panel covered. reference: m² via a scale object."),
      target_segment_ids: z.array(z.number().int()).min(1).optional().describe("panel mode: verified target segments."),
      panel: PanelSpecArg.optional().describe("panel mode: the panel to measure within."),
      segment_ids: z.array(z.number().int()).min(1).optional().describe("reference mode: verified target segments."),
      reference: ScaleReference.optional().describe("reference mode: the scale object visible in the photo."),
    })
    .superRefine((a, ctx) => {
      const need = (field: keyof typeof a) => {
        if (a[field] === undefined) ctx.addIssue({ code: "custom", path: [field], message: `${field} is required in ${a.mode} mode` });
      };
      if (a.mode === "panel") ["target_segment_ids", "panel"].forEach((f) => need(f as keyof typeof a));
      else ["segment_ids", "reference"].forEach((f) => need(f as keyof typeof a));
    }),
  get_previous_assessment: z.object({ boq_item_id: z.number().int() }),
  record_assessment: z.object({
    boq_item_id: z.number().int(),
    percent_complete: z.number().min(0).max(100).optional().describe("Required for items without stages."),
    basis: EvidenceBasis.default("observed").describe(
      "observed (default): visible in this visit's photos. inferred: hidden earlier-sequence work deduced from an item observed in this visit; name that item in the rationale. Not billable until observed.",
    ),
    stage_reached: z
      .string()
      .optional()
      .describe("Staged items only: name of the latest COMPLETED stage, or \"none\". Code computes the percent."),
    qty_done: z.number().nonnegative().optional(),
    panel_measurement_id: z
      .number()
      .int()
      .optional()
      .describe("From measure(mode='panel'), for a single bay. Prefer panel_measurement_ids."),
    panel_measurement_ids: z
      .array(z.number().int())
      .min(1)
      .optional()
      .describe("One measure(mode='panel') result per bay. qty_done = sum of fractions × panel_planned_qty, computed by code."),
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
