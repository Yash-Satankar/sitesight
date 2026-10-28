/**
 * Fixes from dry runs 2 and 3: image budget, panel semantics + multi-bay panels + preview limit,
 * material check, code-computed visual quantities, phone-only ask-backs, floor scoping, and
 * "awaiting photo" status. Meta mocked, PGlite with real migrations, in-memory storage.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { asc, eq } from "drizzle-orm";
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
vi.mock("../src/services/storage.js", () => {
  let n = 0;
  return {
    getObject: async (key: string) => {
      const v = store.get(key);
      if (!v) throw new Error(`no object ${key}`);
      return v;
    },
    putObject: async (key: string, body: Buffer) => void store.set(key, body),
    presignGet: async (key: string) => `file:///${key}`,
    presignPut: async () => {
      throw new Error("no presign in tests");
    },
    newKey: (prefix: string) => `${prefix}/${++n}`,
  };
});

import { migrate } from "drizzle-orm/pglite/migrator";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { db as mockedDb, schema } from "../src/db/client.js";
import { MAX_PANEL_PREVIEWS, runTool, toolDefs, UNMEASURED_AREA_MAX_CONFIDENCE, type ToolContext } from "../src/agent/tools.js";
import { runAgent } from "../src/agent/run.js";
import { systemPrompt } from "../src/agent/prompts.js";
import { boqItemStatus, pendingItems } from "../src/lib/item-status.js";
import { buildReport } from "../src/services/report.js";
import { env } from "../src/config.js";

const db = mockedDb as unknown as PgliteDatabase<typeof schema>;
type ItemValues = typeof schema.boqItems.$inferInsert;

// ---- fixtures ----
async function seed(photoCount = 1) {
  const [project] = await db.insert(schema.projects).values({ name: "P" }).returning();
  const [zone] = await db.insert(schema.zones).values({ projectId: project!.id, name: "Z" }).returning();
  const [visit] = await db.insert(schema.visits).values({ projectId: project!.id, status: "queued" }).returning();
  const jpg = await sharp({ create: { width: 320, height: 334, channels: 3, background: "#888" } }).jpeg().toBuffer();
  const photos = [];
  for (let i = 0; i < photoCount; i++) {
    const key = `visits/${visit!.id}/photos/${i}.jpg`;
    store.set(key, jpg);
    photos.push((await db.insert(schema.photos).values({ visitId: visit!.id, zoneId: zone!.id, storageKey: key, width: 320, height: 334 }).returning())[0]!);
  }
  const [run] = await db.insert(schema.agentRuns).values({ visitId: visit!.id, status: "finished" }).returning();
  const ctx: ToolContext = { runId: run!.id, visitId: visit!.id, projectId: project!.id };
  const item = async (v: Partial<ItemValues>) =>
    (
      await db
        .insert(schema.boqItems)
        .values({ projectId: project!.id, code: "X", description: "x", unit: "m2", plannedQty: 100, measureMode: "visual_only", segmentTargets: [], ...v })
        .returning()
    )[0]!;
  return { ctx, visitId: visit!.id, zoneId: zone!.id, photos, item };
}

async function panelMeasurement(ctx: ToolContext, photoId: number, fraction: number, panel: unknown = { polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] }) {
  const [pm] = await db
    .insert(schema.panelMeasurements)
    .values({ visitId: ctx.visitId, photoId, targetSegmentIds: [], panel, panelAreaPx: 100, coveredAreaPx: fraction * 100, fraction, clipped: false, warnings: [] })
    .returning();
  return pm!.id;
}

const run = (name: string, args: unknown, ctx: ToolContext) => runTool(name, JSON.stringify(args), ctx);
const out = (o: { output: unknown }) => o.output as Record<string, unknown>;
const assess = (ctx: ToolContext, itemId: number, photoId: number, extra: Record<string, unknown>) =>
  run("record_assessment", { boq_item_id: itemId, confidence: 0.8, rationale: "r", evidence: [{ photo_id: photoId, segment_ids: [] }], percent_complete: 40, ...extra }, ctx);

// ---- scripted Spark (snapshots the input at call time; the loop mutates it later) ----
type Item = { type?: string; role?: string; content?: unknown; output?: string };
let inputs: Item[][] = [];
let seq = 0;
const call = (name: string, args: unknown) => ({
  id: `r${++seq}`,
  output: [{ type: "function_call", id: `fc${seq}`, call_id: `c${seq}`, name, arguments: JSON.stringify(args), status: "completed" }],
  output_text: "",
  usage: { input_tokens: 10, output_tokens: 10 },
});
const imagesOf = (input: Item[]) =>
  input.flatMap((i) => (Array.isArray(i.content) && (i.content as { type: string }[]).some((c) => c.type === "input_image") ? [(i.content as { text?: string }[])[0]!.text] : []));
const texts = (input: Item[]) => input.filter((i) => i.role === "user" && typeof i.content === "string").map((i) => i.content as string);

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../src/db/migrations", import.meta.url)) });
});
beforeEach(() => {
  create.mockReset();
  inputs = [];
  seq = 0;
});

// ---------------------------------------------------------------------------------------------

describe("1. image budget", () => {
  it("keeps one image per photo and at most MAX_IMAGES_IN_CONTEXT overall, oldest dropped first", async () => {
    expect(env.MAX_IMAGES_IN_CONTEXT).toBe(3);
    const { visitId, photos } = await seed(4);
    const [p1, p2, p3, p4] = photos.map((p) => p.id);
    const views = [p1, p1, p2, p3, p4];
    create.mockImplementation(async (body: { input: Item[] }) => {
      inputs.push(JSON.parse(JSON.stringify(body.input)));
      const n = inputs.length - 1;
      return n < views.length ? call("view_photo", { photo_id: views[n] }) : call("finish", { summary: "done" });
    });

    await runAgent(visitId);

    expect(inputs.map((i) => imagesOf(i).length)).toEqual([0, 1, 1, 2, 3, 3]);
    expect(imagesOf(inputs[2]!)).toEqual([`Photo ${p1}:`]); // second view of p1 replaced the first
    expect(texts(inputs[2]!)).toContain(`[photo ${p1}: earlier image removed — a newer view follows]`);
    expect(imagesOf(inputs[5]!)).toEqual([`Photo ${p2}:`, `Photo ${p3}:`, `Photo ${p4}:`]); // p1 (oldest) dropped
    expect(texts(inputs[5]!)).toContain(`[photo ${p1}: image dropped to save context — call view_photo again if you need it]`);

    const [latest] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.visitId, visitId)).orderBy(asc(schema.agentRuns.id)).offset(1);
    const steps = await db.select().from(schema.agentSteps).where(eq(schema.agentSteps.runId, latest!.id)).orderBy(asc(schema.agentSteps.idx));
    expect(steps.filter((s) => s.kind === "model").map((s) => (s.payload as { context: { images: number } }).context.images)).toEqual([0, 1, 1, 2, 3, 3]);
    expect(steps.filter((s) => s.name === "images_trimmed")).toHaveLength(2);
  });
});

describe("2. panels", () => {
  it("sums several bays: qty_done = Σ fraction × panel_planned_qty, keeping the single-id form working", async () => {
    const { ctx, photos, item } = await seed(2);
    const brick = await item({ code: "GF-2", measureMode: "area", segmentTargets: ["brickwork"], plannedQty: 180, panelPlannedQty: 12.5 });
    const a = await panelMeasurement(ctx, photos[0]!.id, 0.5);
    const b = await panelMeasurement(ctx, photos[1]!.id, 0.25);

    const res = await assess(ctx, brick.id, photos[0]!.id, { panel_measurement_ids: [a, b], qty_done: 99, percent_complete: 5 });
    expect(out(res)).toMatchObject({ qty_done: 9.375, qty_basis: "(0.5 + 0.25) × 12.5 m2 (panel_planned_qty) = 9.375 m2" });
    expect(JSON.stringify(res.output)).toMatch(/qty_done 99 was ignored/);
    const ev = await db.select().from(schema.assessmentEvidence).where(eq(schema.assessmentEvidence.assessmentId, out(res).assessment_id as number));
    expect(ev.map((e) => e.photoId).sort()).toEqual([photos[0]!.id, photos[1]!.id].sort());

    const single = await assess(ctx, brick.id, photos[0]!.id, { panel_measurement_id: a, percent_complete: 3 });
    expect(out(single)).toMatchObject({ qty_done: 6.25 });
  });

  it("caps at planned_qty, refuses multi-bay without panel_planned_qty, and refuses the same panel twice", async () => {
    const { ctx, photos, item } = await seed(3);
    const small = await item({ code: "S", measureMode: "area", segmentTargets: ["brickwork"], plannedQty: 20, panelPlannedQty: 12.5 });
    const ids = [await panelMeasurement(ctx, photos[0]!.id, 0.9), await panelMeasurement(ctx, photos[1]!.id, 0.9), await panelMeasurement(ctx, photos[2]!.id, 0.9)];
    const capped = await assess(ctx, small.id, photos[0]!.id, { panel_measurement_ids: ids, percent_complete: 100 });
    expect(out(capped)).toMatchObject({ qty_done: 20, qty_basis: "(0.9 + 0.9 + 0.9) × 12.5 m2 (panel_planned_qty) = 33.75 m2, capped at planned_qty 20 m2" });

    const noPanelQty = await item({ code: "N", measureMode: "area", segmentTargets: ["brickwork"], panelPlannedQty: null });
    expect(out(await assess(ctx, noPanelQty.id, photos[0]!.id, { panel_measurement_ids: ids.slice(0, 2) })).error).toMatch(
      /N has no panel_planned_qty, so several bays cannot be added up/,
    );

    const dupA = await panelMeasurement(ctx, photos[0]!.id, 0.4, { polygon: [[1, 1], [9, 1], [9, 9], [1, 9]] });
    const dupB = await panelMeasurement(ctx, photos[0]!.id, 0.5, { polygon: [[1, 1], [9, 1], [9, 9], [1, 9]] });
    expect(out(await assess(ctx, small.id, photos[0]!.id, { panel_measurement_ids: [dupA, dupB] })).error).toMatch(
      new RegExp(`Measurements ${dupA} and ${dupB} are the same panel`),
    );
  });

  it(`allows ${MAX_PANEL_PREVIEWS} draw_panel previews per photo, then tells the model to measure or move on`, async () => {
    const { ctx, photos } = await seed(2);
    const panel = { polygon: [[40, 40], [280, 40], [280, 300], [40, 300]] };
    const first = await run("view_photo", { photo_id: photos[0]!.id, draw_panel: panel }, ctx);
    expect(out(first).panel).not.toHaveProperty("note");
    const second = await run("view_photo", { photo_id: photos[0]!.id, draw_panel: panel }, ctx);
    expect((out(second).panel as { note: string }).note).toMatch(/Last panel preview for photo/);
    const third = await run("view_photo", { photo_id: photos[0]!.id, draw_panel: panel }, ctx);
    expect(out(third).error).toMatch(/Panel preview limit reached .* Call measure\(mode='panel'\) with your best panel now, or record a visual estimate/);
    expect(third.images).toBeUndefined();
    expect((await run("view_photo", { photo_id: photos[1]!.id, draw_panel: panel }, ctx)).images).toHaveLength(1); // other photos unaffected
    expect((await run("view_photo", { photo_id: photos[0]!.id }, ctx)).images).toHaveLength(1); // plain views unaffected
  });

  it("describes a panel as the full designed bay and forbids panels when the bay is not built", () => {
    const measureDesc = toolDefs.find((t) => t.name === "measure")!.description!;
    expect(measureDesc).toMatch(/ONE bay's full designed wall area/);
    expect(measureDesc).toMatch(/Never draw it around the existing masonry only/);
    const prompt = systemPrompt();
    expect(prompt).toMatch(/A panel is the FULL designed wall area of ONE bay: between two cast columns, from the top\s+of the plinth/);
    expect(prompt).toMatch(/do NOT use\s+panel mode: record a visual estimate with confidence ≤ 0\.5/);
    expect(prompt).toMatch(/panel_measurement_ids/);
  });
});

describe("3. material check", () => {
  it("asks for a deviation on material mismatch while still assessing progress", () => {
    const prompt = systemPrompt();
    expect(prompt).toMatch(/Material check: compare the visible material with the BOQ specification/);
    expect(prompt).toMatch(/clay brick vs concrete or fly-ash\s+block vs AAC block/);
    expect(prompt).toMatch(/still assess the progress, but set deviation describing the\s+mismatch/);
  });
});

describe("4. quantities computed in code", () => {
  it("visual_only: qty_done = percent × planned_qty, model qty ignored", async () => {
    const { ctx, photos, item } = await seed();
    const slab = await item({ code: "RF-1", unit: "m3", plannedQty: 36, measureMode: "visual_only" });
    const res = await assess(ctx, slab.id, photos[0]!.id, { percent_complete: 40, qty_done: 30 });
    expect(out(res)).toMatchObject({ qty_done: 14.4, qty_basis: "40% × 36 m3 (planned_qty) = 14.4 m3" });
    expect(JSON.stringify(res.output)).toMatch(/qty_done 30 was ignored; it is computed as percent_complete × planned_qty/);
  });

  it("area item without a panel measurement: confidence capped and qty from percent", async () => {
    const { ctx, photos, item } = await seed();
    const brick = await item({ code: "GF-2", measureMode: "area", segmentTargets: ["brickwork"], plannedQty: 180, panelPlannedQty: 12.5 });
    const res = await assess(ctx, brick.id, photos[0]!.id, { percent_complete: 10, confidence: 0.8 });
    expect(out(res)).toMatchObject({ confidence: UNMEASURED_AREA_MAX_CONFIDENCE, qty_done: 18 });
  });

  it("count items keep the model's count", async () => {
    const { ctx, photos, item } = await seed();
    const cols = await item({ code: "GF-1", unit: "nos", plannedQty: 16, measureMode: "count", segmentTargets: ["column"] });
    expect(out(await assess(ctx, cols.id, photos[0]!.id, { percent_complete: 25, qty_done: 4 }))).toMatchObject({ qty_done: 4 });
  });
});

describe("5. phone-only ask-backs", () => {
  it.each(["Hold a 1 m tape against column C4 and photograph it", "Place an A4 sheet on the wall", "Use a measuring stick"])("refuses %j", async (instruction) => {
    const { ctx, zoneId, visitId } = await seed();
    const res = await run("request_photo", { zone_id: zoneId, instruction, reason: "scale needed" }, ctx);
    expect(out(res).error).toMatch(/Ask-backs must be doable with only a phone/);
    expect(await db.select().from(schema.askBacks).where(eq(schema.askBacks.visitId, visitId))).toHaveLength(0);
  });

  it("accepts a framing request and the prompt gives the phone-only example", async () => {
    const { ctx, zoneId } = await seed();
    const instruction = "Square-on photo of the whole bay between columns C3 and C4, including the beam above and the plinth below";
    expect(out(await run("request_photo", { zone_id: zoneId, instruction, reason: "bay extent" }, ctx))).toMatchObject({ status: "open" });
    const prompt = systemPrompt();
    expect(prompt).toMatch(/Requests must be achievable with only a\s+phone/);
    expect(prompt).toMatch(/Never ask for tapes, A4 sheets or measuring tools/);
    expect(prompt).not.toMatch(/tape held/);
  });
});

describe("6. floor scoping", () => {
  it("prompt scopes items to their floor and the demo BOQ names the slab's floor", async () => {
    expect(systemPrompt()).toMatch(/Floor scoping: each BOQ item covers only the floor and element it names/);
    const demo = JSON.parse(await readFile(fileURLToPath(new URL("../../../samples/boq-demo.json", import.meta.url)), "utf8"));
    expect(demo.items.map((i: { code: string }) => i.code)).toEqual(["PB-1", "GF-1", "RF-1", "GF-2"]);
    expect(demo.items.find((i: { code: string }) => i.code === "RF-1").description).toBe("Ground-floor roof slab (first-floor slab), 125 mm, RCC M20");
  });
});

describe("7. awaiting-photo status", () => {
  it("status strings", () => {
    expect(boqItemStatus(false, [3])).toBe("awaiting photo (ask-back #3)");
    expect(boqItemStatus(false, [])).toBe("not assessed");
    expect(boqItemStatus(true, [])).toBe("assessed");
    expect(boqItemStatus(true, [4])).toBe("assessed (ask-back #4 open)");
  });

  it("lists unassessed items with an open ask-back and prints them in the PDF", async () => {
    const items = [
      { id: 1, code: "GF-1", description: "Columns" },
      { id: 2, code: "GF-2", description: "Brickwork" },
      { id: 3, code: "RF-1", description: "Slab" },
    ];
    const askBacks = [
      { id: 7, boqItemId: 2, status: "open", instruction: "Square-on photo of the bay" },
      { id: 8, boqItemId: 1, status: "open", instruction: "x" }, // item 1 is assessed
      { id: 9, boqItemId: 3, status: "skipped", instruction: "y" },
    ];
    const pending = pendingItems(items, new Set([1]), askBacks);
    expect(pending).toEqual([{ code: "GF-2", description: "Brickwork", status: "awaiting photo (ask-back #7)", instruction: "Square-on photo of the bay" }]);

    const pdf = await buildReport({ projectName: "P", locationLabel: "", visitDate: "2026-10-28", items: [], pending, compress: false });
    const text = [...pdf.toString("latin1").matchAll(/<([0-9a-f]+)>/gi)].map((m) => Buffer.from(m[1]!, "hex").toString("latin1")).join("");
    expect(text).toContain("Awaiting photos");
    expect(text).toContain("awaiting photo (ask-back #7)");
  });
});
