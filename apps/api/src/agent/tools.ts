import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import sharp from "sharp";
import {
  SegmentTarget,
  ToolArgs,
  TOOL_NAMES,
  type AgentStepKind,
  type PanelSpecArg,
  type RejectionPayload,
  type ScaleReference,
  type ToolName,
} from "@sitesight/shared";
import { env } from "../config.js";
import { db, schema } from "../db/client.js";
import type { SparkTool } from "../meta/spark.js";
import { CostLimitError } from "../meta/cost.js";
import { segment as samSegment, type Segment } from "../meta/sam.js";
import { SEGMENT_TARGETS, segmentTargets } from "./concepts.js";
import { loadNormalizedPhoto, toDataUrl } from "../services/images.js";
import { drawMasks, drawPolygon } from "../services/overlay.js";
import { buildPanel, measurePanel, measure as measureSegments, PanelError, type Panel, type Point } from "../services/measure.js";
import { decodeMask } from "../meta/masks.js";
import { getObject, newKey, putObject } from "../services/storage.js";

export interface ToolContext {
  runId: number;
  visitId: number;
  projectId: number;
}

export interface ToolOutcome {
  output: unknown;
  /** Images to show the model after the tool result (as data URLs). */
  images?: { photoId: number; dataUrl: string }[];
  done?: boolean;
  /** Extra trace steps to record after the tool result (e.g. one `rejection` step per rejected segment). */
  events?: { kind: AgentStepKind; name: string; payload: unknown }[];
  /** All segments of this photo are verified: the loop may drop its earlier images from the context. */
  compactPhoto?: { photoId: number; placeholder: string };
}

/** Max long edge of overlay images (masks / panel) sent to the model. */
export const OVERLAY_MAX_EDGE_PX = 1280;

/** zod issues as "decisions[1].reason: required …" strings. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.reduce<string>(
      (acc, part) => (typeof part === "number" ? `${acc}[${part}]` : acc ? `${acc}.${part}` : String(part)),
      "",
    );
    return `${path || "(arguments)"}: ${issue.message}`;
  });
}

/** Mask label in view_photo overlays: id (to reference), target, SAM score, and "ok" once verified. */
export function maskLabel(s: { id: number; concept: string; score: number; verified: boolean | null }): string {
  return `#${s.id} ${s.concept} ${s.score.toFixed(2)}${s.verified ? " ok" : ""}`;
}

const DESCRIPTIONS: Record<ToolName, string> = {
  list_boq_items:
    "List BOQ items (optionally for one zone) with unit, planned_qty, measure_mode and segment_targets (what segment_photo can find for the item).",
  list_photos: "List photos in this visit (optionally for one zone) with transcript and whether segments exist.",
  view_photo:
    "Look at a photo. with_masks=true overlays this photo's masks, each labelled #<segment_id> <target>; rejected segments are hidden. draw_panel outlines a measurement panel (same format as measure's panel) so you can check it before measuring.",
  segment_photo: `Run SAM 3.1 on a photo for measure targets (${SegmentTarget.options.join(", ")}). Returns instances per target with segment ids, areas and scores. Cached. Every instance must then be checked with view_photo(with_masks=true) + verify_segments before measure.`,
  verify_segments:
    "Verify one photo per call, covering all its segments: one decision (keep or reject) for EVERY unverified segment of that photo, after viewing it with with_masks=true. Calls that leave any unverified segment out are refused and save nothing. Rejections need a reason (what it actually is); keeps with a low score need a specific visual reason. measure only accepts kept (verified) segments.",
  measure:
    "Pure code, no model; verified segments only. mode='panel' (preferred for area items): fraction of a wall panel covered by target_segment_ids, where panel is the space between two verified columns (left_column_id, right_column_id, top_y, bottom_y) or a 4-point polygon. Returns measurement_id for record_assessment. mode='reference': count + approximate m² from a scale object (A4/tape/brick) visible in the photo.",
  get_previous_assessment: "Get the last engineer-accepted assessment of a BOQ item from an earlier visit.",
  record_assessment:
    "Record (or overwrite) the progress assessment for one BOQ item in this visit, with evidence. For area items measured in panel mode pass panel_measurement_id: qty_done is then computed by code (fraction × the item's panel_planned_qty, or planned_qty); do not calculate it yourself.",
  request_photo:
    "Ask the site engineer for a specific extra photo when confidence is low. The instruction must be physically specific and doable in 30 seconds.",
  finish: "End the run with a short summary once all relevant items are assessed or have an open photo request.",
};

export const toolDefs: SparkTool[] = TOOL_NAMES.map((name) => {
  const { $schema: _ignored, ...parameters } = zodToJsonSchema(ToolArgs[name], { $refStrategy: "none" }) as Record<
    string,
    unknown
  >;
  return { type: "function", name, description: DESCRIPTIONS[name], parameters, strict: false };
});

const REFERENCE_CONCEPT: Record<ScaleReference, string> = {
  a4: "A4 sheet of paper",
  tape_1m: "measuring tape",
  brick: "single brick",
};

export async function runTool(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolOutcome> {
  if (!(name in ToolArgs)) return { output: { error: `Unknown tool "${name}". Available tools: ${TOOL_NAMES.join(", ")}.` } };
  const tool = name as ToolName;

  let json: unknown;
  try {
    json = rawArgs ? JSON.parse(rawArgs) : {};
  } catch (err) {
    return { output: { error: `Arguments for ${tool} were not valid JSON: ${(err as Error).message}` } };
  }
  const parsed = ToolArgs[tool].safeParse(json);
  if (!parsed.success) {
    // Give the model every issue with its exact path so it can fix the call in one go.
    const issues = formatIssues(parsed.error);
    return { output: { error: `Invalid arguments for ${tool}: ${issues.join("; ")}`, issues } };
  }

  try {
    // Each handler receives its own validated args; the cast is safe because of the lookup above.
    return await (handlers[tool] as (a: unknown, c: ToolContext) => Promise<ToolOutcome>)(parsed.data, ctx);
  } catch (err) {
    // Budget overruns must abort the run, not be handed back to the model as a tool error.
    if (err instanceof CostLimitError) throw err;
    return { output: { error: err instanceof Error ? err.message : String(err) } };
  }
}

type Handlers = { [K in ToolName]: (args: ReturnType<(typeof ToolArgs)[K]["parse"]>, ctx: ToolContext) => Promise<ToolOutcome> };

const handlers: Handlers = {
  async list_boq_items({ zone_id }, ctx) {
    const rows = await db
      .select()
      .from(schema.boqItems)
      .where(
        and(
          eq(schema.boqItems.projectId, ctx.projectId),
          zone_id != null ? or(eq(schema.boqItems.zoneId, zone_id), isNull(schema.boqItems.zoneId)) : undefined,
        ),
      )
      .orderBy(schema.boqItems.id);
    return {
      output: rows.map((r) => ({
        boq_item_id: r.id,
        code: r.code,
        description: r.description,
        zone_id: r.zoneId,
        unit: r.unit,
        planned_qty: r.plannedQty,
        panel_planned_qty: r.panelPlannedQty,
        measure_mode: r.measureMode,
        segment_targets: r.segmentTargets,
      })),
    };
  },

  async list_photos({ zone_id }, ctx) {
    const rows = await db
      .select({ photo: schema.photos, zoneName: schema.zones.name })
      .from(schema.photos)
      .innerJoin(schema.zones, eq(schema.zones.id, schema.photos.zoneId))
      .where(and(eq(schema.photos.visitId, ctx.visitId), zone_id != null ? eq(schema.photos.zoneId, zone_id) : undefined))
      .orderBy(schema.photos.id);
    const ids = rows.map((r) => r.photo.id);
    const segmented = ids.length
      ? new Set(
          (
            await db
              .selectDistinct({ id: schema.segmentQueries.photoId })
              .from(schema.segmentQueries)
              .where(inArray(schema.segmentQueries.photoId, ids))
          ).map((r) => r.id),
        )
      : new Set<number>();
    return {
      output: rows.map(({ photo, zoneName }) => ({
        photo_id: photo.id,
        zone_id: photo.zoneId,
        zone: zoneName,
        transcript: photo.transcript,
        ask_back_id: photo.askBackId,
        has_segments: segmented.has(photo.id),
      })),
    };
  },

  async view_photo({ photo_id, with_masks, draw_panel }, ctx) {
    const photo = await getPhoto(photo_id, ctx);
    const img = await loadNormalizedPhoto(photo.storageKey);
    let buffer = img.buffer;
    let legend: { segment_id: number; target: string; score: number; verified: boolean | null }[] = [];
    let hiddenRejected = 0;
    if (with_masks) {
      const all = await db.select().from(schema.segments).where(eq(schema.segments.photoId, photo.id)).orderBy(schema.segments.id);
      const segs = all.filter((s) => s.verified !== false);
      hiddenRejected = all.length - segs.length;
      if (segs.length) {
        // Labels carry the segment id (to reference in verify_segments / measure) and the SAM score.
        const masks = await Promise.all(
          segs.map(async (s) => ({ mask: await getObject(s.maskKey), bbox: s.bbox, label: maskLabel(s) })),
        );
        buffer = await drawMasks(buffer, masks);
        legend = segs.map((s) => ({ segment_id: s.id, target: s.concept, score: round2(s.score), verified: s.verified }));
      }
    }
    let panelPreview: Record<string, unknown> | undefined;
    if (draw_panel) {
      const { panel } = await resolvePanel(photo, draw_panel);
      buffer = await drawPolygon(buffer, panel.outline, "PANEL");
      panelPreview = {
        panel_area_px: panel.areaPx,
        share_of_image: Math.round((panel.areaPx / (panel.width * panel.height)) * 1000) / 1000,
        clipped: panel.clipped,
        warnings: panel.warnings,
      };
    }

    // Overlays only need enough detail to judge masks; a smaller image keeps input tokens down.
    let shown = { width: img.width, height: img.height };
    if ((with_masks || draw_panel) && Math.max(img.width, img.height) > OVERLAY_MAX_EDGE_PX) {
      const { data, info } = await sharp(buffer)
        .resize({ width: OVERLAY_MAX_EDGE_PX, height: OVERLAY_MAX_EDGE_PX, fit: "inside" })
        .jpeg({ quality: 82 })
        .toBuffer({ resolveWithObject: true });
      buffer = data;
      shown = { width: info.width, height: info.height };
    }
    const scaled = shown.width !== img.width;
    return {
      output: {
        photo_id: photo.id,
        width: img.width,
        height: img.height,
        ...(scaled
          ? {
              shown_width: shown.width,
              shown_height: shown.height,
              coordinate_note: `Shown at ${shown.width}×${shown.height}. Panel coordinates (top_y, bottom_y, polygon) are in ${img.width}×${img.height} photo pixels: multiply what you read off this image by ${round2(img.width / shown.width)}.`,
            }
          : {}),
        mask_legend: legend,
        hidden_rejected_segments: hiddenRejected,
        ...(panelPreview ? { panel: panelPreview } : {}),
        note: "Image follows.",
      },
      images: [{ photoId: photo.id, dataUrl: toDataUrl(buffer) }],
    };
  },

  async segment_photo({ photo_id, targets }, ctx) {
    const photo = await getPhoto(photo_id, ctx);
    const segs = await ensureSegments(photo, targets, ctx);
    return {
      output: {
        targets: targets.map((target) => {
          const mine = segs.filter((s) => s.concept === target);
          return {
            target,
            instance_count: mine.length,
            instances: mine.map((s) => ({
              segment_id: s.id,
              area_px: s.areaPx,
              score: round2(s.score),
              bbox: s.bbox,
              verified: s.verified,
            })),
          };
        }),
        next_step: `View the masks with view_photo(photo_id=${photo.id}, with_masks=true) and call verify_segments for every unverified instance before measure.`,
      },
    };
  },

  async verify_segments({ photo_id, decisions }, ctx) {
    const photo = await getPhoto(photo_id, ctx);
    const ids = decisions.map((d) => d.segment_id);
    const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    if (dupes.length) return { output: { error: `Duplicate segment_ids in decisions: ${dupes.join(", ")}` } };
    // (A rejection without a reason is refused by the argument schema.)

    const rows = await db
      .select()
      .from(schema.segments)
      .where(and(eq(schema.segments.photoId, photo.id), inArray(schema.segments.id, ids)));
    const onPhoto = new Set(rows.map((r) => r.id));
    const foreign = ids.filter((id) => !onPhoto.has(id));
    if (foreign.length) {
      // Nothing is updated: a decision about the wrong photo's segment is a model mistake, not a partial success.
      return {
        output: {
          error: `segment_ids ${foreign.join(", ")} are not segments of photo ${photo.id}. Only verify ids that segment_photo returned for this photo. No decisions were saved.`,
        },
      };
    }

    // One photo per call, covering all of it: piecemeal verification burned the step budget in the first dry run.
    const unverified = await db
      .select({ id: schema.segments.id })
      .from(schema.segments)
      .where(and(eq(schema.segments.photoId, photo.id), isNull(schema.segments.verified)))
      .orderBy(schema.segments.id);
    const decided = new Set(ids);
    const missing = unverified.map((u) => u.id).filter((id) => !decided.has(id));
    if (missing.length) {
      return {
        output: {
          error: `verify_segments must decide every unverified segment of photo ${photo.id} in one call. Missing decisions for segment_ids ${missing.join(", ")}. No decisions were saved; call again with all of them.`,
          missing_segment_ids: missing,
        },
      };
    }

    await db.transaction(async (tx) => {
      for (const d of decisions) {
        await tx
          .update(schema.segments)
          .set({ verified: d.keep, rejectReason: d.keep ? null : d.reason!.trim() })
          .where(eq(schema.segments.id, d.segment_id));
      }
    });

    const byId = new Map(rows.map((r) => [r.id, r]));
    const rejected = decisions.filter((d) => !d.keep);
    const all = await db.select().from(schema.segments).where(eq(schema.segments.photoId, photo.id)).orderBy(schema.segments.id);
    return {
      output: {
        ok: true,
        kept: decisions.filter((d) => d.keep).map((d) => d.segment_id),
        rejected: rejected.map((d) => d.segment_id),
        unverified_remaining: [],
      },
      events: rejected.map((d) => ({
        kind: "rejection" as const,
        name: "verify_segments",
        payload: {
          photo_id: photo.id,
          segment_id: d.segment_id,
          target: byId.get(d.segment_id)!.concept,
          reason: d.reason!.trim(),
        } satisfies RejectionPayload,
      })),
      compactPhoto: { photoId: photo.id, placeholder: verifiedPlaceholder(photo.id, all) },
    };
  },

  async measure(args, ctx) {
    const photo = await getPhoto(args.photo_id, ctx);

    if (args.mode === "reference") {
      const targets = await verifiedSegments(photo, args.segment_ids!);
      if ("error" in targets) return { output: targets };
      const refSegs = await ensureSegments(photo, [REFERENCE_CONCEPT[args.reference!]], ctx);
      const ref = refSegs.sort((a, b) => b.score - a.score)[0] ?? null;
      const result = measureSegments(targets, args.reference!, ref, photo);
      return {
        output: {
          mode: "reference",
          count: result.count,
          area_m2: result.areaM2,
          scale_confidence: result.scaleConfidence,
          reference_segment_id: ref?.id ?? null,
          notes: result.notes,
        },
      };
    }

    // Panel mode: covered fraction of a wall panel. No real-world scale needed.
    const targets = await verifiedSegments(photo, args.target_segment_ids!);
    if ("error" in targets) return { output: targets };
    const { panel, columnIds } = await resolvePanel(photo, args.panel!);
    const rasters = await Promise.all(targets.map(async (t) => decodeMask(await getObject(t.maskKey))));
    const m = measurePanel(rasters, panel);
    const overlap = targets.filter((t) => columnIds.includes(t.id)).map((t) => t.id);
    if (overlap.length) m.warnings.push(`Segments ${overlap.join(", ")} are the panel's columns; they should not be targets.`);

    const [row] = await db
      .insert(schema.panelMeasurements)
      .values({
        visitId: ctx.visitId,
        photoId: photo.id,
        runId: ctx.runId,
        targetSegmentIds: targets.map((t) => t.id),
        panel: args.panel!,
        panelAreaPx: m.panelAreaPx,
        coveredAreaPx: m.coveredAreaPx,
        fraction: m.fraction,
        clipped: m.clipped,
        warnings: m.warnings,
      })
      .returning({ id: schema.panelMeasurements.id });

    return {
      output: {
        mode: "panel",
        measurement_id: row!.id,
        panel_area_px: m.panelAreaPx,
        covered_area_px: m.coveredAreaPx,
        fraction: m.fraction,
        clipped: m.clipped,
        warnings: m.warnings,
        next_step: `If the warnings are fine, call record_assessment with panel_measurement_id=${row!.id}; qty_done is computed for you.`,
      },
    };
  },

  async get_previous_assessment({ boq_item_id }, ctx) {
    const [row] = await db
      .select({ a: schema.assessments, visitDate: schema.visits.visitDate })
      .from(schema.assessments)
      .innerJoin(schema.visits, eq(schema.visits.id, schema.assessments.visitId))
      .where(
        and(
          eq(schema.assessments.boqItemId, boq_item_id),
          ne(schema.assessments.visitId, ctx.visitId),
          inArray(schema.assessments.status, ["accepted", "edited"]),
        ),
      )
      .orderBy(desc(schema.visits.visitDate), desc(schema.assessments.id))
      .limit(1);
    if (!row) return { output: { found: false } };
    return {
      output: {
        found: true,
        visit_date: row.visitDate,
        percent_complete: row.a.percentComplete,
        qty_done: row.a.qtyDone,
        rationale: row.a.rationale,
        engineer_note: row.a.engineerNote,
      },
    };
  },

  async record_assessment(args, ctx) {
    const [item] = await db
      .select()
      .from(schema.boqItems)
      .where(and(eq(schema.boqItems.id, args.boq_item_id), eq(schema.boqItems.projectId, ctx.projectId)));
    if (!item) return { output: { error: `boq_item_id ${args.boq_item_id} not found in this project` } };

    const photoIds = args.evidence.map((e) => e.photo_id);
    const valid = await db
      .select({ id: schema.photos.id })
      .from(schema.photos)
      .where(and(eq(schema.photos.visitId, ctx.visitId), inArray(schema.photos.id, photoIds)));
    if (valid.length !== new Set(photoIds).size) return { output: { error: "Evidence cites photos not in this visit." } };

    let confidence = args.confidence;
    const notes: string[] = [];
    if (item.measureMode === "visual_only" && confidence > env.VISUAL_ONLY_MAX_CONFIDENCE) {
      confidence = env.VISUAL_ONLY_MAX_CONFIDENCE;
      notes.push(`Confidence capped at ${confidence} for visual_only items.`);
    }

    // Panel measurement: the quantity comes from the stored fraction, never from the model's arithmetic.
    let qtyDone = args.qty_done ?? null;
    let qtyBasis: string | null = null;
    let panelEvidence: { photoId: number; segmentIds: number[] } | null = null;
    if (args.panel_measurement_id != null) {
      const [pm] = await db.select().from(schema.panelMeasurements).where(eq(schema.panelMeasurements.id, args.panel_measurement_id));
      if (!pm || pm.visitId !== ctx.visitId) {
        return { output: { error: `panel_measurement_id ${args.panel_measurement_id} is not a measurement from this visit.` } };
      }
      if (item.measureMode !== "area") {
        return { output: { error: `Panel measurements apply to area items; ${item.code} is measured as ${item.measureMode}.` } };
      }
      const basis = item.panelPlannedQty ?? item.plannedQty;
      qtyDone = Math.round(pm.fraction * basis * 1000) / 1000;
      qtyBasis = `${pm.fraction} × ${basis} ${item.unit} (${item.panelPlannedQty != null ? "panel_planned_qty" : "planned_qty"}) = ${qtyDone} ${item.unit}`;
      if (item.panelPlannedQty == null) {
        notes.push(`${item.code} has no panel_planned_qty, so the panel was taken as the whole item (${item.plannedQty} ${item.unit}).`);
      }
      if (args.qty_done != null && args.qty_done !== qtyDone) {
        notes.push(`qty_done ${args.qty_done} was ignored; it is computed from the panel measurement.`);
      }
      if (item.plannedQty > 0) {
        const implied = (qtyDone / item.plannedQty) * 100;
        if (Math.abs(args.percent_complete - implied) > 10) {
          notes.push(`percent_complete ${args.percent_complete} differs from the ${Math.round(implied)}% implied by qty_done; check it.`);
        }
      }
      panelEvidence = { photoId: pm.photoId, segmentIds: pm.targetSegmentIds };
    }

    const values = {
      visitId: ctx.visitId,
      boqItemId: item.id,
      percentComplete: Math.min(100, args.percent_complete),
      qtyDone,
      confidence,
      rationale: args.rationale,
      deviation: args.deviation ?? null,
      status: "proposed" as const,
    };
    const assessmentId = await db.transaction(async (tx) => {
      const [a] = await tx
        .insert(schema.assessments)
        .values(values)
        .onConflictDoUpdate({ target: [schema.assessments.visitId, schema.assessments.boqItemId], set: values })
        .returning({ id: schema.assessments.id });
      await tx.delete(schema.assessmentEvidence).where(eq(schema.assessmentEvidence.assessmentId, a!.id));
      const merged = new Map<number, Set<number>>();
      const evidence = [
        ...args.evidence,
        ...(panelEvidence ? [{ photo_id: panelEvidence.photoId, segment_ids: panelEvidence.segmentIds }] : []),
      ];
      for (const e of evidence) {
        const set = merged.get(e.photo_id) ?? new Set<number>();
        e.segment_ids.forEach((id) => set.add(id));
        merged.set(e.photo_id, set);
      }
      await tx
        .insert(schema.assessmentEvidence)
        .values([...merged].map(([photoId, segs]) => ({ assessmentId: a!.id, photoId, segmentIds: [...segs] })));
      return a!.id;
    });

    const lowConfidence = confidence < env.ASK_BACK_THRESHOLD;
    if (lowConfidence) notes.push(`Confidence is below ${env.ASK_BACK_THRESHOLD}; consider request_photo.`);
    return {
      output: { ok: true, assessment_id: assessmentId, confidence, qty_done: qtyDone, ...(qtyBasis ? { qty_basis: qtyBasis } : {}), notes },
    };
  },

  async request_photo(args, ctx) {
    const [zone] = await db
      .select()
      .from(schema.zones)
      .where(and(eq(schema.zones.id, args.zone_id), eq(schema.zones.projectId, ctx.projectId)));
    if (!zone) return { output: { error: `zone_id ${args.zone_id} not found` } };
    const [ab] = await db
      .insert(schema.askBacks)
      .values({
        visitId: ctx.visitId,
        zoneId: zone.id,
        boqItemId: args.boq_item_id ?? null,
        instruction: args.instruction,
        reason: args.reason,
      })
      .returning({ id: schema.askBacks.id });
    return { output: { ask_back_id: ab!.id, status: "open" } };
  },

  async finish({ summary }) {
    return { output: { ok: true, summary }, done: true };
  },
};

// ---- helpers ----

type PhotoRow = typeof schema.photos.$inferSelect;
type SegmentRow = typeof schema.segments.$inferSelect;

async function getPhoto(photoId: number, ctx: ToolContext): Promise<PhotoRow> {
  const [photo] = await db
    .select()
    .from(schema.photos)
    .where(and(eq(schema.photos.id, photoId), eq(schema.photos.visitId, ctx.visitId)));
  if (!photo) throw new Error(`photo_id ${photoId} is not in this visit`);
  return photo;
}

/** Text that replaces a fully verified photo's images in the conversation, so the outcome stays in context. */
export function verifiedPlaceholder(photoId: number, segs: { id: number; verified: boolean | null; rejectReason: string | null }[]): string {
  const list = (items: string[]) => (items.length > 25 ? `${items.slice(0, 25).join(", ")}, … (${items.length} total)` : items.join(", ") || "none");
  const kept = segs.filter((s) => s.verified === true).map((s) => String(s.id));
  const rejected = segs
    .filter((s) => s.verified === false)
    .map((s) => `${s.id} (${(s.rejectReason ?? "").slice(0, 40)})`);
  return `[photo ${photoId} image removed — verified: kept ${list(kept)}; rejected ${list(rejected)}. Call view_photo again to see it.]`;
}

/** Segments of this photo with the given ids, all verified — or an error message for the model. */
async function verifiedSegments(
  photo: PhotoRow,
  ids: number[],
  what = "measure only accepts verified segments.",
): Promise<SegmentRow[] | { error: string }> {
  const rows = await db
    .select()
    .from(schema.segments)
    .where(and(eq(schema.segments.photoId, photo.id), inArray(schema.segments.id, ids)));
  if (rows.length !== new Set(ids).size) return { error: "Some segment_ids do not belong to this photo." };
  const pending = rows.filter((t) => t.verified == null).map((t) => t.id);
  const rejected = rows.filter((t) => t.verified === false);
  if (!pending.length && !rejected.length) return rows;
  const parts = [what];
  if (pending.length) {
    parts.push(
      `Segments ${pending.join(", ")} are not verified yet: call view_photo(photo_id=${photo.id}, with_masks=true), then verify_segments for photo ${photo.id} first.`,
    );
  }
  if (rejected.length) parts.push(`Segments ${rejected.map((r) => `${r.id} (${r.rejectReason})`).join(", ")} were rejected; leave them out.`);
  return { error: parts.join(" ") };
}

/** Turn the model's panel argument into a pixel region. Throws PanelError with a message for the model. */
async function resolvePanel(photo: PhotoRow, spec: PanelSpecArg): Promise<{ panel: Panel; columnIds: number[] }> {
  if ("polygon" in spec) {
    return { panel: buildPanel({ kind: "polygon", points: spec.polygon as Point[] }, photo.width, photo.height), columnIds: [] };
  }
  const ids = [spec.left_column_id, spec.right_column_id];
  if (ids[0] === ids[1]) throw new PanelError("left_column_id and right_column_id must be two different columns.");
  const cols = await verifiedSegments(photo, ids, "Panel columns must be verified segments.");
  if ("error" in cols) throw new PanelError(cols.error);
  const notColumns = cols.filter((c) => c.concept !== "column");
  if (notColumns.length) {
    throw new PanelError(`Segments ${notColumns.map((c) => `${c.id} (${c.concept})`).join(", ")} are not columns.`);
  }
  const mask = async (id: number) => decodeMask(await getObject(cols.find((c) => c.id === id)!.maskKey));
  const [left, right] = await Promise.all([mask(spec.left_column_id), mask(spec.right_column_id)]);
  return {
    panel: buildPanel({ kind: "columns", left, right, topY: spec.top_y, bottomY: spec.bottom_y }, photo.width, photo.height),
    columnIds: ids,
  };
}

/**
 * Run SAM only for keys not already queried on this photo; return all segments for `keys`.
 * A key is a measure target ("column", "brickwork": prompt variants + IoU merge, see concepts.ts)
 * or a raw prompt (scale references in measure). Segments are stored under their key.
 */
async function ensureSegments(photo: PhotoRow, keys: string[], ctx: ToolContext): Promise<SegmentRow[]> {
  const done = await db
    .select({ concept: schema.segmentQueries.concept })
    .from(schema.segmentQueries)
    .where(and(eq(schema.segmentQueries.photoId, photo.id), inArray(schema.segmentQueries.concept, keys)));
  const doneSet = new Set(done.map((d) => d.concept));
  const missing = keys.filter((c) => !doneSet.has(c));

  if (missing.length) {
    const img = await loadNormalizedPhoto(photo.storageKey);
    const missingTargets = missing.filter((k): k is SegmentTarget => k in SEGMENT_TARGETS);
    const missingPrompts = missing.filter((k) => !(k in SEGMENT_TARGETS));
    const found: Segment[] = [];
    if (missingTargets.length) {
      const byTarget = await segmentTargets(img.buffer, missingTargets, { runId: ctx.runId });
      for (const segs of byTarget.values()) found.push(...segs);
    }
    if (missingPrompts.length) found.push(...(await samSegment(img.buffer, missingPrompts, { runId: ctx.runId })));

    for (const s of found) {
      const maskKey = newKey(`masks/${photo.id}`, "image/png");
      await putObject(maskKey, s.mask, "image/png");
      await db.insert(schema.segments).values({
        photoId: photo.id,
        concept: s.concept,
        instanceIdx: s.instanceIdx,
        maskKey,
        bbox: s.bbox,
        areaPx: s.areaPx,
        score: s.score,
      });
    }
    await db
      .insert(schema.segmentQueries)
      .values(missing.map((concept) => ({ photoId: photo.id, concept })))
      .onConflictDoNothing();
  }

  return db
    .select()
    .from(schema.segments)
    .where(and(eq(schema.segments.photoId, photo.id), inArray(schema.segments.concept, keys)))
    .orderBy(schema.segments.concept, schema.segments.instanceIdx);
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
