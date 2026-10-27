import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ToolArgs, TOOL_NAMES, type ToolName, type ScaleReference } from "@sitesight/shared";
import { env } from "../config.js";
import { db, schema } from "../db/client.js";
import type { SparkTool } from "../meta/spark.js";
import { CostLimitError } from "../meta/cost.js";
import { segment as samSegment } from "../meta/sam.js";
import { loadNormalizedPhoto, toDataUrl } from "../services/images.js";
import { drawMasks } from "../services/overlay.js";
import { measure as measureSegments } from "../services/measure.js";
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
}

const DESCRIPTIONS: Record<ToolName, string> = {
  list_boq_items: "List BOQ items (optionally for one zone) with unit, planned_qty, measure_mode and SAM concepts.",
  list_photos: "List photos in this visit (optionally for one zone) with transcript and whether segments exist.",
  view_photo: "Look at a photo. with_masks=true overlays existing segmentation masks labelled #<segment_id>.",
  segment_photo: "Run SAM 3.1 on a photo for up to 5 concepts. Returns instances per concept with segment ids, areas and scores. Cached.",
  measure:
    "Convert segments to a count and approximate area in m² using a scale reference visible in the same photo. Pure code, no model.",
  get_previous_assessment: "Get the last engineer-accepted assessment of a BOQ item from an earlier visit.",
  record_assessment: "Record (or overwrite) the progress assessment for one BOQ item in this visit, with evidence.",
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
  if (!(name in ToolArgs)) return { output: { error: `Unknown tool "${name}"` } };
  const tool = name as ToolName;

  let json: unknown;
  try {
    json = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { output: { error: "Arguments were not valid JSON." } };
  }
  const parsed = ToolArgs[tool].safeParse(json);
  if (!parsed.success) return { output: { error: "Invalid arguments", issues: parsed.error.flatten() } };

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
        measure_mode: r.measureMode,
        sam_concepts: r.samConcepts,
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

  async view_photo({ photo_id, with_masks }, ctx) {
    const photo = await getPhoto(photo_id, ctx);
    const img = await loadNormalizedPhoto(photo.storageKey);
    let buffer = img.buffer;
    let legend: { segment_id: number; concept: string; score: number }[] = [];
    if (with_masks) {
      const segs = await db.select().from(schema.segments).where(eq(schema.segments.photoId, photo.id));
      if (segs.length) {
        const masks = await Promise.all(
          segs.map(async (s) => ({ mask: await getObject(s.maskKey), bbox: s.bbox, label: `#${s.id} ${s.concept}` })),
        );
        buffer = await drawMasks(buffer, masks);
        legend = segs.map((s) => ({ segment_id: s.id, concept: s.concept, score: s.score }));
      }
    }
    return {
      output: { photo_id: photo.id, width: img.width, height: img.height, mask_legend: legend, note: "Image follows." },
      images: [{ photoId: photo.id, dataUrl: toDataUrl(buffer) }],
    };
  },

  async segment_photo({ photo_id, concepts }, ctx) {
    const photo = await getPhoto(photo_id, ctx);
    const segs = await ensureSegments(photo, concepts, ctx);
    return {
      output: concepts.map((concept) => {
        const mine = segs.filter((s) => s.concept === concept);
        return {
          concept,
          instance_count: mine.length,
          instances: mine.map((s) => ({ segment_id: s.id, area_px: s.areaPx, score: round2(s.score), bbox: s.bbox })),
        };
      }),
    };
  },

  async measure({ photo_id, segment_ids, reference }, ctx) {
    const photo = await getPhoto(photo_id, ctx);
    const targets = await db
      .select()
      .from(schema.segments)
      .where(and(eq(schema.segments.photoId, photo.id), inArray(schema.segments.id, segment_ids)));
    if (targets.length !== segment_ids.length) {
      return { output: { error: "Some segment_ids do not belong to this photo." } };
    }
    const refSegs = await ensureSegments(photo, [REFERENCE_CONCEPT[reference]], ctx);
    const ref = refSegs.sort((a, b) => b.score - a.score)[0] ?? null;
    const result = measureSegments(targets, reference, ref, photo);
    return {
      output: {
        count: result.count,
        area_m2: result.areaM2,
        scale_confidence: result.scaleConfidence,
        reference_segment_id: ref?.id ?? null,
        notes: result.notes,
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

    const values = {
      visitId: ctx.visitId,
      boqItemId: item.id,
      percentComplete: Math.min(100, args.percent_complete),
      qtyDone: args.qty_done ?? null,
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
      for (const e of args.evidence) {
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
    return { output: { ok: true, assessment_id: assessmentId, confidence, notes } };
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

/** Run SAM only for concepts not already queried on this photo; return all segments for `concepts`. */
async function ensureSegments(photo: PhotoRow, concepts: string[], ctx: ToolContext): Promise<SegmentRow[]> {
  const done = await db
    .select({ concept: schema.segmentQueries.concept })
    .from(schema.segmentQueries)
    .where(and(eq(schema.segmentQueries.photoId, photo.id), inArray(schema.segmentQueries.concept, concepts)));
  const doneSet = new Set(done.map((d) => d.concept));
  const missing = concepts.filter((c) => !doneSet.has(c));

  if (missing.length) {
    const img = await loadNormalizedPhoto(photo.storageKey);
    const found = await samSegment(img.buffer, missing, { runId: ctx.runId });
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
    .where(and(eq(schema.segments.photoId, photo.id), inArray(schema.segments.concept, concepts)))
    .orderBy(schema.segments.concept, schema.segments.instanceIdx);
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
