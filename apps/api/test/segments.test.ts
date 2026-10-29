/**
 * Target-based segmentation, IoU merge of prompt variants, and verify-before-measure.
 * Meta client mocked (SAM answers per prompt), PGlite with the real migrations, in-memory storage.
 * SAM outputs reuse the real sample from @meta-sam/parser's README: two instances in a 320×334 frame.
 */
import { fileURLToPath } from "node:url";
import { and, asc, eq } from "drizzle-orm";
import sharp from "sharp";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { create, store } = vi.hoisted(() => ({ create: vi.fn(), store: new Map<string, Buffer>() }));

vi.mock("../src/meta/client.js", () => ({ metaClient: () => ({ responses: { create } }) }));

vi.mock("../src/db/client.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("../src/db/schema.js");
  return { db: drizzle(new PGlite(), { schema }), schema, sql: { end: async () => {} } };
});

vi.mock("../src/services/storage.js", async () => {
  const photo = await sharp({ create: { width: 320, height: 334, channels: 3, background: "#888" } }).jpeg().toBuffer();
  let n = 0;
  return {
    getObject: async (key: string) => store.get(key) ?? photo, // stored masks, else the site photo
    putObject: async (key: string, body: Buffer) => void store.set(key, body),
    presignGet: async (key: string) => `https://storage.test/${key}`,
    presignPut: async (key: string) => `https://storage.test/${key}`,
    newKey: (prefix: string) => `${prefix}/${++n}`,
  };
});

import { migrate } from "drizzle-orm/pglite/migrator";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { db as mockedDb, schema } from "../src/db/client.js";
import { runTool, type ToolContext } from "../src/agent/tools.js";
import { runAgent } from "../src/agent/run.js";
import { segmentTargets, SEGMENT_TARGETS, MERGE_IOU_THRESHOLD } from "../src/agent/concepts.js";
import { mergeOverlapping, maskIoU, rasterToFrameMask } from "../src/meta/masks.js";
import { boqItemProblem, normalizeBoqItem } from "../src/services/boq-rules.js";
import { env } from "../src/config.js";

const db = mockedDb as unknown as PgliteDatabase<typeof schema>;

// ---- SAM fixtures (real masks; confidence values chosen per test) ----
const RIGHT = (c: number) =>
  `0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334;c=${c}|>` +
  `<|mask;x=0;y=0;c=${c};data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7\`e.ioeAf6-k/#Xd8%dX9x(|>`;
const LEFT = (c: number) =>
  `1<|box;x1=155;y1=228;x2=202;y2=254;w=320;h=334;c=${c}|>` +
  `<|mask;x=0;y=0;c=${c};data=27,48,~!!!!J!0c[q=Pj_zs=*4C4(/./x#:/\`S_GnD\`=o3?X{emCgO$y@|>`;
const frame = (...records: string[]) => (records.length ? `<0f>${records.join(",")}\n` : "");

/** SAM answers by prompt text; Spark answers are queued per test. */
function mockMeta(samByPrompt: Record<string, string>, sparkQueue: unknown[] = []) {
  create.mockImplementation(async (body: { model: string; input: { content: { text?: string }[] }[] }) => {
    if (body.model === env.SAM_MODEL) {
      const prompt = body.input[0]!.content[0]!.text!;
      return { id: "sam", output: [], output_text: samByPrompt[prompt] ?? "", usage: { input_tokens: 0, output_tokens: 0 } };
    }
    const next = sparkQueue.shift();
    if (!next) throw new Error("unexpected Spark call");
    return next;
  });
}

let callSeq = 0;
const sparkCall = (name: string, args: unknown) => ({
  id: `r${++callSeq}`,
  output: [{ type: "function_call", id: `fc${callSeq}`, call_id: `c${callSeq}`, name, arguments: JSON.stringify(args), status: "completed" }],
  output_text: "",
  usage: { input_tokens: 10, output_tokens: 10 },
});

// ---- DB fixtures ----
async function seed() {
  const [project] = await db.insert(schema.projects).values({ name: "P" }).returning();
  const [zone] = await db.insert(schema.zones).values({ projectId: project!.id, name: "Z" }).returning();
  const [visit] = await db.insert(schema.visits).values({ projectId: project!.id }).returning();
  const [run] = await db.insert(schema.agentRuns).values({ visitId: visit!.id }).returning();
  const photo = async () =>
    (
      await db
        .insert(schema.photos)
        .values({ visitId: visit!.id, zoneId: zone!.id, storageKey: `visits/${visit!.id}/photos/p.jpg`, width: 320, height: 334 })
        .returning()
    )[0]!;
  const ctx: ToolContext = { runId: run!.id, visitId: visit!.id, projectId: project!.id };
  return { ctx, visitId: visit!.id, photo1: await photo(), photo2: await photo() };
}

async function insertSegment(
  photoId: number,
  concept = "column",
  verified: boolean | null = null,
  [x, y, w, h]: [number, number, number, number] = [20, 20, 10, 10],
) {
  const mask = (await rasterToFrameMask(new Uint8Array(w * h).fill(1), w, h, x, y, 320, 334)).png;
  const maskKey = `masks/manual/${Math.random()}`;
  store.set(maskKey, mask);
  const [s] = await db
    .insert(schema.segments)
    .values({ photoId, concept, instanceIdx: 0, maskKey, bbox: [x, y, w, h], areaPx: w * h, score: 0.8, verified })
    .returning();
  return s!;
}

const segmentRow = async (id: number) => (await db.select().from(schema.segments).where(eq(schema.segments.id, id)))[0]!;
const run = (name: string, args: unknown, ctx: ToolContext) => runTool(name, JSON.stringify(args), ctx);
const errorOf = (o: { output: unknown }) => (o.output as { error?: string }).error;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../src/db/migrations", import.meta.url)) });
});
beforeEach(() => {
  create.mockReset();
  callSeq = 0;
});

// ---------------------------------------------------------------------------------------------

describe("IoU merge of prompt variants", () => {
  const rect = (x: number, y: number, w: number, h: number, score: number) =>
    rasterToFrameMask(new Uint8Array(w * h).fill(1), w, h, x, y, 100, 100).then((m) => ({ ...m, mask: m.png, score }));

  it("keeps the higher-score instance when masks overlap more than the threshold", async () => {
    const low = await rect(0, 0, 10, 10, 0.6);
    const high = await rect(1, 0, 10, 10, 0.9); // IoU = 90 / 110 ≈ 0.82
    const apart = await rect(50, 50, 10, 10, 0.3);
    expect(await maskIoU(low, high)).toBeCloseTo(90 / 110);

    const merged = await mergeOverlapping([low, apart, high], MERGE_IOU_THRESHOLD);
    expect(merged.map((m) => m.score)).toEqual([0.9, 0.3]);
  });

  it("keeps both when overlap is at or below the threshold", async () => {
    const a = await rect(0, 0, 10, 10, 0.6);
    const b = await rect(5, 0, 10, 10, 0.9); // IoU = 50 / 150 ≈ 0.33
    expect(await mergeOverlapping([a, b], MERGE_IOU_THRESHOLD)).toHaveLength(2);
  });

  it("segmentTargets runs every brickwork prompt and merges duplicates, keeping the higher score", async () => {
    expect(SEGMENT_TARGETS.brickwork.prompts).toEqual(["exposed brick wall", "brickwork"]);
    mockMeta({
      "exposed brick wall": frame(RIGHT(0.6)), // same wall found by both prompts…
      brickwork: frame(RIGHT(0.9), LEFT(0.7)), // …plus one only this prompt finds
    });
    const image = await sharp({ create: { width: 320, height: 334, channels: 3, background: "#888" } }).jpeg().toBuffer();

    const result = await segmentTargets(image, ["brickwork"]);

    const bricks = result.get("brickwork")!;
    expect(bricks.map((s) => [s.concept, s.instanceIdx, s.score])).toEqual([
      ["brickwork", 0, 0.9], // the 0.6 duplicate was dropped
      ["brickwork", 1, 0.7],
    ]);
    expect(create.mock.calls.map(([b]) => b.input[0].content[0].text).sort()).toEqual(["brickwork", "exposed brick wall"]);
  });
});

describe("segment_photo", () => {
  it("accepts target names only", async () => {
    const { ctx, photo1 } = await seed();
    const out = await run("segment_photo", { photo_id: photo1.id, targets: ["concrete slab"] }, ctx);
    expect(errorOf(out)).toBe(
      "Invalid arguments for segment_photo: targets[0]: Invalid enum value. Expected 'column' | 'brickwork', received 'concrete slab'",
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("stores merged instances under the target name, unverified", async () => {
    const { ctx, photo1 } = await seed();
    mockMeta({ "exposed brick wall": frame(RIGHT(0.6)), brickwork: frame(RIGHT(0.9), LEFT(0.7)) });

    const out = (await run("segment_photo", { photo_id: photo1.id, targets: ["brickwork"] }, ctx)).output as {
      targets: { target: string; instances: { segment_id: number; score: number; verified: boolean | null }[] }[];
      next_step: string;
    };

    expect(out.targets[0]!.target).toBe("brickwork");
    expect(out.targets[0]!.instances.map((i) => [i.score, i.verified])).toEqual([
      [0.9, null],
      [0.7, null],
    ]);
    expect(out.next_step).toMatch(/verify_segments/);
    const rows = await db.select().from(schema.segments).where(eq(schema.segments.photoId, photo1.id));
    expect(rows.every((r) => r.concept === "brickwork")).toBe(true);
  });
});

describe("verify-before-measure", () => {
  it("measure refuses unverified segments and tells the model to verify first", async () => {
    const { ctx, photo1 } = await seed();
    const seg = await insertSegment(photo1.id);
    mockMeta({});

    const out = await run("measure", { photo_id: photo1.id, mode: "reference", segment_ids: [seg.id], reference: "a4" }, ctx);

    expect(errorOf(out)).toMatch(/measure only accepts verified segments/);
    expect(errorOf(out)).toMatch(new RegExp(`Segments ${seg.id} are not verified yet: call view_photo\\(photo_id=${photo1.id}, with_masks=true\\), then verify_segments`));
    expect(create).not.toHaveBeenCalled(); // refused before any SAM call for the scale reference
  });

  it("measure accepts verified segments and refuses rejected ones with their reason", async () => {
    const { ctx, photo1 } = await seed();
    const good = await insertSegment(photo1.id);
    const bad = await insertSegment(photo1.id);
    mockMeta({}); // reference prompt finds nothing

    const verify = await run(
      "verify_segments",
      { photo_id: photo1.id, decisions: [{ segment_id: good.id, keep: true, reason: "column C2" }, { segment_id: bad.id, keep: false, reason: "scaffolding pole" }] },
      ctx,
    );
    expect(verify.output).toMatchObject({ ok: true, kept: [good.id], rejected: [bad.id], unverified_remaining: [] });
    expect(verify.events).toEqual([
      { kind: "rejection", name: "verify_segments", payload: { photo_id: photo1.id, segment_id: bad.id, target: "column", reason: "scaffolding pole" } },
    ]);
    expect(await segmentRow(bad.id)).toMatchObject({ verified: false, rejectReason: "scaffolding pole" });

    const ok = await run("measure", { photo_id: photo1.id, mode: "reference", segment_ids: [good.id], reference: "a4" }, ctx);
    expect(errorOf(ok)).toBeUndefined();
    expect(ok.output).toMatchObject({ count: 1, area_m2: null });

    const refused = await run("measure", { photo_id: photo1.id, mode: "reference", segment_ids: [good.id, bad.id], reference: "a4" }, ctx);
    expect(errorOf(refused)).toMatch(new RegExp(`Segments ${bad.id} \\(scaffolding pole\\) were rejected`));
  });

  it("verify_segments rejects ids from another photo and saves nothing", async () => {
    const { ctx, photo1, photo2 } = await seed();
    const mine = await insertSegment(photo1.id);
    const theirs = await insertSegment(photo2.id);

    const out = await run(
      "verify_segments",
      { photo_id: photo1.id, decisions: [{ segment_id: mine.id, keep: true, reason: "" }, { segment_id: theirs.id, keep: false, reason: "tree" }] },
      ctx,
    );

    expect(errorOf(out)).toMatch(new RegExp(`segment_ids ${theirs.id} are not segments of photo ${photo1.id}.*No decisions were saved`));
    expect(out.events).toBeUndefined();
    expect((await segmentRow(mine.id)).verified).toBeNull(); // the valid decision in the same call was not applied
    expect((await segmentRow(theirs.id)).verified).toBeNull();
  });

  it("verify_segments requires a reason for each rejection", async () => {
    const { ctx, photo1 } = await seed();
    const seg = await insertSegment(photo1.id);
    const out = await run("verify_segments", { photo_id: photo1.id, decisions: [{ segment_id: seg.id, keep: false, reason: "  " }] }, ctx);
    expect(errorOf(out)).toContain("decisions[0].reason: required when keep is false");
    expect((await segmentRow(seg.id)).verified).toBeNull();
  });

  it("view_photo(with_masks) labels masks by segment id and hides rejected ones", async () => {
    const { ctx, photo1 } = await seed();
    const pending = await insertSegment(photo1.id);
    const kept = await insertSegment(photo1.id, "column", true);
    await insertSegment(photo1.id, "column", false);

    const out = await run("view_photo", { photo_id: photo1.id, with_masks: true }, ctx);

    expect(out.output).toMatchObject({
      mask_legend: [
        { segment_id: pending.id, target: "column", verified: null },
        { segment_id: kept.id, target: "column", verified: true },
      ],
      hidden_rejected_segments: 1,
    });
    expect(out.images).toHaveLength(1);
  });

  it("rejections become their own trace steps in an agent run", async () => {
    const { visitId, photo1 } = await seed();
    const keep = await insertSegment(photo1.id);
    const reject = await insertSegment(photo1.id);
    mockMeta({}, [
      sparkCall("verify_segments", {
        photo_id: photo1.id,
        decisions: [{ segment_id: keep.id, keep: true, reason: "column" }, { segment_id: reject.id, keep: false, reason: "tree trunk" }],
      }),
      sparkCall("finish", { summary: "done" }),
    ]);

    await expect(runAgent(visitId)).resolves.toBe("assessed");

    const [latest] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.visitId, visitId)).orderBy(asc(schema.agentRuns.id)).limit(1).offset(1);
    const steps = await db.select().from(schema.agentSteps).where(and(eq(schema.agentSteps.runId, latest!.id))).orderBy(asc(schema.agentSteps.idx));
    expect(steps.map((s) => `${s.kind}:${s.name}`)).toEqual([
      "model:null",
      "tool_call:verify_segments",
      "tool_result:verify_segments",
      "rejection:verify_segments",
      "model:null",
      "tool_call:finish",
      "tool_result:finish",
    ]);
    expect(steps[3]!.payload).toEqual({ photo_id: photo1.id, segment_id: reject.id, target: "column", reason: "tree trunk" });
  });
});

describe("panel measurement (tools)", () => {
  // Photo 320×334. Columns at x 40..59 and 260..279 → panel x [60, 260), y [50, 250): 200 × 200 = 40,000 px.
  async function panelSetup() {
    const s = await seed();
    const left = await insertSegment(s.photo1.id, "column", true, [40, 0, 20, 334]);
    const right = await insertSegment(s.photo1.id, "column", true, [260, 0, 20, 334]);
    const halfWall = await insertSegment(s.photo1.id, "brickwork", true, [60, 150, 200, 100]); // bottom half of the panel
    const panel = { left_column_id: left.id, right_column_id: right.id, top_y: 50, bottom_y: 250 };
    return { ...s, left, right, halfWall, panel };
  }

  async function brickItem(projectId: number, panelPlannedQty: number | null) {
    const [it] = await db
      .insert(schema.boqItems)
      .values({ projectId, code: "3.1", description: "Brick masonry", unit: "m2", plannedQty: 380, measureMode: "area", segmentTargets: ["brickwork"], panelPlannedQty })
      .returning();
    return it!;
  }

  it("measures the covered fraction between two verified columns and stores the measurement", async () => {
    const { ctx, photo1, halfWall, panel } = await panelSetup();

    const out = await run("measure", { photo_id: photo1.id, mode: "panel", target_segment_ids: [halfWall.id], panel }, ctx);

    expect(errorOf(out)).toBeUndefined();
    expect(out.output).toMatchObject({ mode: "panel", panel_area_px: 40000, covered_area_px: 20000, fraction: 0.5, clipped: false, warnings: [] });
    const id = (out.output as { measurement_id: number }).measurement_id;
    const [row] = await db.select().from(schema.panelMeasurements).where(eq(schema.panelMeasurements.id, id));
    expect(row).toMatchObject({ visitId: ctx.visitId, photoId: photo1.id, fraction: 0.5, targetSegmentIds: [halfWall.id] });
  });

  it("polygon panel gives the same result as the column panel", async () => {
    const { ctx, photo1, halfWall } = await panelSetup();
    const out = await run(
      "measure",
      { photo_id: photo1.id, mode: "panel", target_segment_ids: [halfWall.id], panel: { polygon: [[60, 50], [260, 50], [260, 250], [60, 250]] } },
      ctx,
    );
    expect(out.output).toMatchObject({ panel_area_px: 40000, covered_area_px: 20000, fraction: 0.5 });
  });

  it("requires the panel columns to be verified column segments", async () => {
    const { ctx, photo1, left, halfWall } = await panelSetup();
    const unverified = await insertSegment(photo1.id, "column", null, [260, 0, 20, 334]);
    const out = await run(
      "measure",
      { photo_id: photo1.id, mode: "panel", target_segment_ids: [halfWall.id], panel: { left_column_id: left.id, right_column_id: unverified.id, top_y: 50, bottom_y: 250 } },
      ctx,
    );
    expect(errorOf(out)).toMatch(/Panel columns must be verified segments/);

    const notColumn = await run(
      "measure",
      { photo_id: photo1.id, mode: "panel", target_segment_ids: [halfWall.id], panel: { left_column_id: left.id, right_column_id: halfWall.id, top_y: 50, bottom_y: 250 } },
      ctx,
    );
    expect(errorOf(notColumn)).toMatch(new RegExp(`Segments ${halfWall.id} \\(brickwork\\) are not columns`));
  });

  it("validates mode-specific arguments", async () => {
    const { ctx, photo1, halfWall } = await panelSetup();
    const out = await run("measure", { photo_id: photo1.id, mode: "panel", target_segment_ids: [halfWall.id] }, ctx);
    expect(errorOf(out)).toBe("Invalid arguments for measure: panel: panel is required in panel mode");
  });

  it("record_assessment computes qty_done = fraction × panel_planned_qty and ignores the model's number", async () => {
    const { ctx, photo1, halfWall, panel } = await panelSetup();
    const item = await brickItem(ctx.projectId, 12);
    const m = await run("measure", { photo_id: photo1.id, mode: "panel", target_segment_ids: [halfWall.id], panel }, ctx);
    const measurementId = (m.output as { measurement_id: number }).measurement_id;

    const out = await run(
      "record_assessment",
      {
        boq_item_id: item.id,
        percent_complete: 2,
        qty_done: 99, // wrong on purpose: must be ignored
        panel_measurement_id: measurementId,
        confidence: 0.8,
        rationale: "Lower half of the bay is laid.",
        evidence: [{ photo_id: photo1.id, segment_ids: [] }],
      },
      ctx,
    );

    expect(errorOf(out)).toBeUndefined();
    expect(out.output).toMatchObject({ qty_done: 6, qty_basis: "0.5 × 12 m2 (panel_planned_qty) = 6 m2" });
    expect(JSON.stringify(out.output)).toMatch(/qty_done 99 was ignored/);
    const [a] = await db.select().from(schema.assessments).where(eq(schema.assessments.boqItemId, item.id));
    expect(a!.qtyDone).toBe(6);
    const ev = await db.select().from(schema.assessmentEvidence).where(eq(schema.assessmentEvidence.assessmentId, a!.id));
    expect(ev).toEqual([expect.objectContaining({ photoId: photo1.id, segmentIds: [halfWall.id] })]); // measurement's targets added
  });

  it("falls back to planned_qty when the item has no panel_planned_qty, and says so", async () => {
    const { ctx, photo1, halfWall, panel } = await panelSetup();
    const item = await brickItem(ctx.projectId, null);
    const m = await run("measure", { photo_id: photo1.id, mode: "panel", target_segment_ids: [halfWall.id], panel }, ctx);
    const out = await run(
      "record_assessment",
      {
        boq_item_id: item.id,
        percent_complete: 50,
        panel_measurement_id: (m.output as { measurement_id: number }).measurement_id,
        confidence: 0.7,
        rationale: "x",
        evidence: [{ photo_id: photo1.id, segment_ids: [halfWall.id] }],
      },
      ctx,
    );
    expect(out.output).toMatchObject({ qty_done: 190 });
    expect(JSON.stringify(out.output)).toMatch(/no panel_planned_qty, so the panel was taken as the whole item/);
  });

  it("refuses a panel measurement from another visit", async () => {
    const a = await panelSetup();
    const m = await run("measure", { photo_id: a.photo1.id, mode: "panel", target_segment_ids: [a.halfWall.id], panel: a.panel }, a.ctx);
    const b = await seed();
    const item = await brickItem(b.ctx.projectId, 12);
    const out = await run(
      "record_assessment",
      {
        boq_item_id: item.id,
        percent_complete: 50,
        panel_measurement_id: (m.output as { measurement_id: number }).measurement_id,
        confidence: 0.7,
        rationale: "x",
        evidence: [{ photo_id: b.photo1.id, segment_ids: [] }],
      },
      b.ctx,
    );
    expect(errorOf(out)).toMatch(/is not a measurement from this visit/);
  });

  it("view_photo(draw_panel) overlays the panel and reports its size", async () => {
    const { ctx, photo1, panel } = await panelSetup();
    const out = await run("view_photo", { photo_id: photo1.id, draw_panel: panel }, ctx);
    expect(errorOf(out)).toBeUndefined();
    expect(out.output).toMatchObject({ panel: { panel_area_px: 40000, clipped: false, warnings: [] } });
    expect(out.images).toHaveLength(1);
  });
});

describe("BOQ rules", () => {
  const item = (measureMode: "count" | "area" | "visual_only", segmentTargets: ("column" | "brickwork")[]) => ({
    zoneId: null,
    code: "1.1",
    description: "x",
    unit: "nos" as const,
    plannedQty: 1,
    measureMode,
    segmentTargets,
    panelPlannedQty: null,
    stages: null,
    sequenceNo: null,
    drawingSource: null,
  });

  it("accepts column counts, brickwork areas and visual-only items", () => {
    expect(boqItemProblem(item("count", ["column"]))).toBeNull();
    expect(boqItemProblem(item("area", ["brickwork"]))).toBeNull();
    expect(boqItemProblem(item("visual_only", []))).toBeNull();
  });

  it("flags count/area without a matching target and falls back to visual_only", () => {
    expect(boqItemProblem(item("area", []))).toMatch(/need a segment target/);
    expect(boqItemProblem(item("count", ["brickwork"]))).toMatch(/cannot be measured as count/);
    expect(normalizeBoqItem(item("area", [])).item).toMatchObject({ measureMode: "visual_only", segmentTargets: [] });
    expect(normalizeBoqItem(item("count", ["column", "brickwork"])).item.segmentTargets).toEqual(["column"]);
    expect(normalizeBoqItem(item("visual_only", ["column"])).item).toMatchObject({ measureMode: "visual_only", segmentTargets: [] });
  });

  it("only allows panel_planned_qty on area items", () => {
    expect(boqItemProblem({ ...item("area", ["brickwork"]), panelPlannedQty: 12.5 })).toBeNull();
    expect(boqItemProblem({ ...item("count", ["column"]), panelPlannedQty: 3 })).toMatch(/only applies to area items/);
    expect(normalizeBoqItem({ ...item("count", ["column"]), panelPlannedQty: 3 }).item.panelPlannedQty).toBeNull();
  });
});
