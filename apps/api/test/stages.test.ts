/**
 * Stage-based progress, regressions as deviations, and the Demo Residence sample BOQ.
 * PGlite with real migrations; no model calls needed (tools are called directly).
 */
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { stagePercent, type BoqItemInput } from "@sitesight/shared";

vi.mock("../src/meta/client.js", () => ({
  metaClient: () => ({ responses: { create: vi.fn(async () => { throw new Error("no model calls in this file"); }) } }),
}));
vi.mock("../src/db/client.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("../src/db/schema.js");
  return { db: drizzle(new PGlite(), { schema }), schema, sql: { end: async () => {} } };
});

import { migrate } from "drizzle-orm/pglite/migrator";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { db as mockedDb, schema } from "../src/db/client.js";
import { runTool, type ToolContext } from "../src/agent/tools.js";
import { systemPrompt } from "../src/agent/prompts.js";
import { boqItemProblem, normalizeBoqItem } from "../src/services/boq-rules.js";
import { discoverZones, parseBoqJson } from "../scripts/dry-run-lib.js";

const db = mockedDb as unknown as PgliteDatabase<typeof schema>;
const SLAB_STAGES = [
  { name: "shuttering", weight: 0.25 },
  { name: "reinforcement", weight: 0.35 },
  { name: "concreting", weight: 0.4 },
];

async function seed() {
  const [project] = await db.insert(schema.projects).values({ name: "P" }).returning();
  const [zone] = await db.insert(schema.zones).values({ projectId: project!.id, name: "GF" }).returning();
  const visit = async () => (await db.insert(schema.visits).values({ projectId: project!.id }).returning())[0]!;
  const v1 = await visit();
  const v2 = await visit();
  const photo = async (visitId: number) =>
    (await db.insert(schema.photos).values({ visitId, zoneId: zone!.id, storageKey: `k${visitId}`, width: 10, height: 10 }).returning())[0]!;
  const p2 = await photo(v2.id);
  const [run] = await db.insert(schema.agentRuns).values({ visitId: v2.id }).returning();
  const ctx: ToolContext = { runId: run!.id, visitId: v2.id, projectId: project!.id };
  const [slab] = await db
    .insert(schema.boqItems)
    .values({ projectId: project!.id, code: "SLB-GF", description: "GF roof slab", unit: "m3", plannedQty: 12.7, measureMode: "visual_only", stages: SLAB_STAGES })
    .returning();
  const [footing] = await db
    .insert(schema.boqItems)
    .values({ projectId: project!.id, code: "FTG-1", description: "Footings", unit: "nos", plannedQty: 10, measureMode: "visual_only" })
    .returning();
  return { ctx, v1, v2, p2, slab: slab!, footing: footing! };
}

const run = (name: string, args: unknown, ctx: ToolContext) => runTool(name, JSON.stringify(args), ctx);
const out = (o: { output: unknown }) => o.output as Record<string, unknown>;
const record = (ctx: ToolContext, itemId: number, photoId: number, extra: Record<string, unknown>) =>
  run("record_assessment", { boq_item_id: itemId, confidence: 0.6, rationale: "seen", evidence: [{ photo_id: photoId, segment_ids: [] }], ...extra }, ctx);

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../src/db/migrations", import.meta.url)) });
});

describe("1. stages", () => {
  it("cumulative weight up to and including the stage reached", () => {
    expect(stagePercent(SLAB_STAGES, "shuttering")).toBe(25);
    expect(stagePercent(SLAB_STAGES, "reinforcement")).toBe(60);
    expect(stagePercent(SLAB_STAGES, "concreting")).toBe(100);
    expect(stagePercent(SLAB_STAGES, "none")).toBe(0);
    expect(stagePercent(SLAB_STAGES, "curing")).toBeNull();
  });

  it("validates stage lists", () => {
    const item = (stages: BoqItemInput["stages"], measureMode: BoqItemInput["measureMode"] = "visual_only"): BoqItemInput => ({
      zoneId: null, code: "S", description: "s", unit: "m3", plannedQty: 1, measureMode,
      segmentTargets: measureMode === "count" ? ["column"] : [], panelPlannedQty: null, stages, sequenceNo: null, drawingSource: null,
    });
    expect(boqItemProblem(item(SLAB_STAGES))).toBeNull();
    expect(boqItemProblem(item([{ name: "a", weight: 0.5 }, { name: "b", weight: 0.4 }]))).toBe("stage weights must sum to 1 (got 0.9)");
    expect(boqItemProblem(item([{ name: "a", weight: 0.5 }, { name: "A", weight: 0.5 }]))).toMatch(/stage names must be unique \(repeated: a\)/);
    expect(boqItemProblem(item([{ name: "none", weight: 0.5 }, { name: "b", weight: 0.5 }]))).toMatch(/"none" is reserved/);
    expect(boqItemProblem(item(SLAB_STAGES, "count"))).toBe("stages only apply to visual_only items");
    expect(normalizeBoqItem(item([{ name: "a", weight: 0.7 }, { name: "b", weight: 0.7 }])).item.stages).toBeNull();
  });

  it("record_assessment takes stage_reached and computes percent and qty; a model percent is ignored", async () => {
    const { ctx, p2, slab } = await seed();
    const res = await record(ctx, slab.id, p2.id, { stage_reached: "reinforcement", percent_complete: 90, qty_done: 12 });
    expect(out(res)).toMatchObject({
      percent_complete: 60,
      stage_reached: "reinforcement",
      qty_done: 7.62,
      qty_basis: 'stage "reinforcement" (0.25 + 0.35) = 60% × 12.7 m3 (planned_qty) = 7.62 m3',
    });
    const notes = JSON.stringify(out(res).notes);
    expect(notes).toMatch(/percent_complete 90 was ignored; for staged items it is computed from stage_reached \(\\"reinforcement\\" → 60%\)/);
    expect(notes).toMatch(/qty_done 12 was ignored/);
    const [a] = await db.select().from(schema.assessments).where(eq(schema.assessments.id, out(res).assessment_id as number));
    expect(a).toMatchObject({ percentComplete: 60, stageReached: "reinforcement", qtyDone: 7.62 });

    expect(out(await record(ctx, slab.id, p2.id, { stage_reached: "none" }))).toMatchObject({ percent_complete: 0, qty_done: 0 });
  });

  it("explains missing or unknown stages and mixed-up arguments", async () => {
    const { ctx, p2, slab, footing } = await seed();
    expect(out(await record(ctx, slab.id, p2.id, { percent_complete: 50 })).error).toBe(
      'SLB-GF is a staged item: give stage_reached (the latest completed stage: "shuttering", "reinforcement", "concreting" or "none"), not percent_complete.',
    );
    expect(out(await record(ctx, slab.id, p2.id, { stage_reached: "curing" })).error).toMatch(/stage_reached "curing" is not a stage of SLB-GF/);
    expect(out(await record(ctx, footing.id, p2.id, { stage_reached: "shuttering" })).error).toBe("FTG-1 has no stages; give percent_complete instead of stage_reached.");
    expect(out(await record(ctx, footing.id, p2.id, {})).error).toBe("percent_complete is required for FTG-1.");
  });

  it("list_boq_items shows the stages and the prompt asks for the latest COMPLETED stage", async () => {
    const { ctx } = await seed();
    const items = out(await run("list_boq_items", {}, ctx)) as unknown as { code: string; stages: unknown }[];
    expect(items.find((i) => i.code === "SLB-GF")!.stages).toEqual(SLAB_STAGES);
    expect(systemPrompt()).toMatch(/identify the latest\s+COMPLETED stage from visible evidence and pass it as stage_reached/);
    expect(systemPrompt()).toMatch(/Name the\s+stage and the evidence for it in the rationale/);
  });
});

describe("3. previous assessments and regressions", () => {
  async function accepted(visitId: number, itemId: number, percent: number, stageReached: string | null = null) {
    await db.insert(schema.assessments).values({
      visitId, boqItemId: itemId, percentComplete: percent, stageReached, confidence: 0.7, rationale: "earlier", status: "accepted",
    });
  }

  it("get_previous_assessment returns the accepted stage", async () => {
    const { ctx, v1, slab } = await seed();
    await accepted(v1.id, slab.id, 25, "shuttering");
    expect(out(await run("get_previous_assessment", { boq_item_id: slab.id }, ctx))).toMatchObject({ found: true, percent_complete: 25, stage_reached: "shuttering" });
  });

  it("records progress going backwards as a deviation, also when the model gave its own deviation", async () => {
    const { ctx, v1, p2, slab, footing } = await seed();
    await accepted(v1.id, footing.id, 60);
    await accepted(v1.id, slab.id, 60, "reinforcement");

    const silent = await record(ctx, footing.id, p2.id, { percent_complete: 40 });
    expect(out(silent).deviation).toMatch(/^Progress went backwards: 60% at the visit of \d{4}-\d{2}-\d{2}, now 40%\.$/);
    expect(JSON.stringify(out(silent).notes)).toMatch(/Recorded as a deviation/);

    const staged = await record(ctx, slab.id, p2.id, { stage_reached: "shuttering", deviation: "Shuttering re-erected after a pour failure." });
    expect(out(staged).deviation).toMatch(/^Shuttering re-erected after a pour failure\. Progress went backwards: 60% \(reinforcement\) at the visit of .*, now 25% \(shuttering\)\.$/);

    const forward = await record(ctx, footing.id, p2.id, { percent_complete: 80 });
    expect(out(forward).deviation).toBeUndefined();
  });

  it("prompt: state what changed since the previous assessment; regressions are deviations", () => {
    expect(systemPrompt()).toMatch(/state in the rationale what changed since then/);
    expect(systemPrompt()).toMatch(/Progress going backwards must be flagged as a deviation with the reason, never recorded silently/);
  });
});

describe("4. samples/boq-demo-residence.json", () => {
  it("is a consistent single-zone BOQ with a staged slab", async () => {
    const text = await readFile(fileURLToPath(new URL("../../../samples/boq-demo-residence.json", import.meta.url)), "utf8");
    const { items, zones } = parseBoqJson(text);
    expect(zones).toEqual(["GF"]);
    expect(items.map((i) => [i.code, i.unit, i.plannedQty, i.measureMode, i.segmentTargets])).toEqual([
      ["FTG-1", "nos", 10, "visual_only", []],
      ["COL-GF", "nos", 12, "count", ["column"]],
      ["PB-1", "lot", 1, "visual_only", []],
      ["SLB-GF", "m3", 12.7, "visual_only", []],
    ]);
    expect(items.find((i) => i.code === "SLB-GF")!.stages).toEqual(SLAB_STAGES);
    for (const { zone: _z, ...it } of items) expect(boqItemProblem({ ...it, zoneId: null })).toBeNull();
  });

  it("declared zones: loose photos go to the single zone; undeclared subfolders are refused", async () => {
    const root = await mkdtemp(join(tmpdir(), "zones-"));
    await writeFile(join(root, "a.jpg"), "x");
    expect((await discoverZones(root, { declaredZones: ["GF"] })).map((z) => z.name)).toEqual(["GF"]);
    await mkdir(join(root, "FF"));
    await writeFile(join(root, "FF", "b.jpg"), "x");
    await expect(discoverZones(root, { declaredZones: ["GF"] })).rejects.toThrow(/Photo folder "FF" .* is not a zone declared in the BOQ \(GF\)/);
  });
});
