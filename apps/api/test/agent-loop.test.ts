/**
 * Fixes from the first real dry run (hit the step limit with no assessments):
 * 1 actionable validation errors · 2 verify_segments reason rules · 3 batched verification ·
 * 4 score in mask labels, overlays ≤ 1280 px · 5 context compaction · 6 wrap-up and `partial` runs.
 * Meta mocked, PGlite with real migrations, in-memory storage.
 */
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
import { maskLabel, OVERLAY_MAX_EDGE_PX, runTool, type ToolContext } from "../src/agent/tools.js";
import { runAgent, WRAP_UP_TURNS } from "../src/agent/run.js";
import { WRAP_UP } from "../src/agent/prompts.js";
import { rasterToFrameMask } from "../src/meta/masks.js";
import { env } from "../src/config.js";

const db = mockedDb as unknown as PgliteDatabase<typeof schema>;

// ---- fixtures ----
async function jpeg(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: "#888" } }).jpeg().toBuffer();
}

async function seed({ width = 320, height = 334 } = {}) {
  const [project] = await db.insert(schema.projects).values({ name: "P" }).returning();
  const [zone] = await db.insert(schema.zones).values({ projectId: project!.id, name: "Z" }).returning();
  const [item] = await db
    .insert(schema.boqItems)
    .values({ projectId: project!.id, code: "1.1", description: "RCC columns", unit: "nos", plannedQty: 10, measureMode: "count", segmentTargets: ["column"] })
    .returning();
  const [visit] = await db.insert(schema.visits).values({ projectId: project!.id, status: "queued" }).returning();
  const key = `visits/${visit!.id}/photos/p.jpg`;
  store.set(key, await jpeg(width, height));
  const [photo] = await db.insert(schema.photos).values({ visitId: visit!.id, zoneId: zone!.id, storageKey: key, width, height }).returning();
  const [run] = await db.insert(schema.agentRuns).values({ visitId: visit!.id, status: "finished" }).returning();
  const ctx: ToolContext = { runId: run!.id, visitId: visit!.id, projectId: project!.id };
  return { ctx, visitId: visit!.id, photo: photo!, item: item!, width, height };
}

async function addSegment(photoId: number, width: number, height: number, score = 0.8, verified: boolean | null = null) {
  const mask = (await rasterToFrameMask(new Uint8Array(100).fill(1), 10, 10, 20, 20, width, height)).png;
  const maskKey = `masks/${Math.random()}`;
  store.set(maskKey, mask);
  const [s] = await db
    .insert(schema.segments)
    .values({ photoId, concept: "column", instanceIdx: 0, maskKey, bbox: [20, 20, 10, 10], areaPx: 100, score, verified })
    .returning();
  return s!;
}

const run = (name: string, args: unknown, ctx: ToolContext) => runTool(name, JSON.stringify(args), ctx);
const errorOf = (o: { output: unknown }) => (o.output as { error?: string }).error;
const segRow = async (id: number) => (await db.select().from(schema.segments).where(eq(schema.segments.id, id)))[0]!;

// ---- scripted Spark: snapshots each call's input (the loop mutates the same array afterwards) ----
type Item = { type?: string; role?: string; content?: unknown; output?: string; call_id?: string };
let inputs: Item[][] = [];
let seq = 0;
const call = (...calls: [string, unknown][]) => ({
  id: `r${++seq}`,
  output: calls.map(([name, args], i) => ({
    type: "function_call",
    id: `fc${seq}-${i}`,
    call_id: `c${seq}-${i}`,
    name,
    arguments: JSON.stringify(args),
    status: "completed",
  })),
  output_text: "",
  usage: { input_tokens: 10, output_tokens: 10 },
});
function script(steps: ((input: Item[]) => unknown)[], sam: Record<string, string> = {}) {
  create.mockImplementation(async (body: { model: string; input: Item[] }) => {
    if (body.model === env.SAM_MODEL) {
      const prompt = (body.input[0]!.content as { text: string }[])[0]!.text;
      return { id: "sam", output: [], output_text: sam[prompt] ?? "", usage: { input_tokens: 0, output_tokens: 0 } };
    }
    inputs.push(JSON.parse(JSON.stringify(body.input)));
    const step = steps[Math.min(inputs.length - 1, steps.length - 1)]!;
    return step(body.input);
  });
}
const toolOutputs = (input: Item[]) => input.filter((i) => i.type === "function_call_output").map((i) => JSON.parse(i.output!));
const images = (input: Item[]) =>
  input.filter((i) => Array.isArray(i.content) && (i.content as { type: string }[]).some((c) => c.type === "input_image")).length;
const texts = (input: Item[]) => input.filter((i) => i.role === "user" && typeof i.content === "string").map((i) => i.content as string);

async function stepsOfLatestRun(visitId: number) {
  const runs = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.visitId, visitId)).orderBy(asc(schema.agentRuns.id));
  const latest = runs.at(-1)!;
  return {
    run: latest,
    steps: await db.select().from(schema.agentSteps).where(eq(schema.agentSteps.runId, latest.id)).orderBy(asc(schema.agentSteps.idx)),
  };
}

// Real SAM output sample (two instances, 320×334 frame) from @meta-sam/parser's README.
const SAM_TWO =
  "<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334;c=0.8|><|mask;x=0;y=0;c=0.8;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>" +
  ",1<|box;x1=155;y1=228;x2=202;y2=254;w=320;h=334;c=0.45|><|mask;x=0;y=0;c=0.45;data=27,48,~!!!!J!0c[q=Pj_zs=*4C4(/./x#:/`S_GnD`=o3?X{emCgO$y@|>\n";

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../src/db/migrations", import.meta.url)) });
});
beforeEach(() => {
  create.mockReset();
  inputs = [];
  seq = 0;
});

// ---------------------------------------------------------------------------------------------

describe("1. actionable tool errors", () => {
  it("returns every zod issue with its path, and the text reaches the model", async () => {
    const { visitId, photo, width, height } = await seed();
    const a = await addSegment(photo.id, width, height);
    const b = await addSegment(photo.id, width, height);
    script([
      () => call(["verify_segments", { photo_id: photo.id, decisions: [{ segment_id: a.id, keep: false }, { segment_id: b.id }] }]),
      () => call(["finish", { summary: "x" }]),
    ]);

    await runAgent(visitId);

    const err = toolOutputs(inputs[1]!)[0].error as string;
    expect(err).toContain("Invalid arguments for verify_segments:");
    expect(err).toContain("decisions[0].reason: required when keep is false");
    expect(err).toContain("decisions[1].keep: Required");
    expect(err).not.toMatch(/^Invalid arguments$/);
  });

  it("explains unknown tools and bad JSON", async () => {
    const { ctx } = await seed();
    expect(errorOf(await runTool("verify", "{}", ctx))).toMatch(/Unknown tool "verify". Available tools: .*verify_segments/);
    expect(errorOf(await runTool("list_photos", "{oops", ctx))).toMatch(/^Arguments for list_photos were not valid JSON: /);
  });
});

describe("2. verify_segments reasons", () => {
  it("accepts many decisions in one call; reason optional to keep, required to reject", async () => {
    const { ctx, photo, width, height } = await seed();
    const segs = [];
    for (let i = 0; i < 12; i++) segs.push(await addSegment(photo.id, width, height));
    const decisions = segs.map((s, i) => (i < 10 ? { segment_id: s.id, keep: true } : { segment_id: s.id, keep: false, reason: "scaffolding pole" }));

    const out = await run("verify_segments", { photo_id: photo.id, decisions }, ctx);

    expect(errorOf(out)).toBeUndefined();
    expect((out.output as { kept: number[] }).kept).toHaveLength(10);
    expect(await segRow(segs[11]!.id)).toMatchObject({ verified: false, rejectReason: "scaffolding pole" });
    expect(await segRow(segs[0]!.id)).toMatchObject({ verified: true, rejectReason: null });

    const blank = await run("verify_segments", { photo_id: photo.id, decisions: [{ segment_id: segs[0]!.id, keep: false, reason: "   " }] }, ctx);
    expect(errorOf(blank)).toContain("decisions[0].reason: required when keep is false");
  });
});

describe("3. batched verification", () => {
  it("refuses a call that leaves unverified segments out, lists them and saves nothing", async () => {
    const { ctx, photo, width, height } = await seed();
    const [a, b, c] = [await addSegment(photo.id, width, height), await addSegment(photo.id, width, height), await addSegment(photo.id, width, height)];
    const done = await addSegment(photo.id, width, height, 0.9, true); // already verified: not required again

    const out = await run("verify_segments", { photo_id: photo.id, decisions: [{ segment_id: a.id, keep: true }] }, ctx);

    expect(errorOf(out)).toBe(
      `verify_segments must decide every unverified segment of photo ${photo.id} in one call. Missing decisions for segment_ids ${b.id}, ${c.id}. No decisions were saved; call again with all of them.`,
    );
    expect((out.output as { missing_segment_ids: number[] }).missing_segment_ids).toEqual([b.id, c.id]);
    expect((await segRow(a.id)).verified).toBeNull();

    const full = await run(
      "verify_segments",
      { photo_id: photo.id, decisions: [a, b, c].map((s) => ({ segment_id: s.id, keep: true })) },
      ctx,
    );
    expect(errorOf(full)).toBeUndefined();
    expect((await segRow(done.id)).verified).toBe(true);
  });
});

describe("4. verification aids", () => {
  it("mask labels show id, target and SAM score", () => {
    expect(maskLabel({ id: 12, concept: "column", score: 0.456, verified: null })).toBe("#12 column 0.46");
    expect(maskLabel({ id: 3, concept: "brickwork", score: 0.9, verified: true })).toBe("#3 brickwork 0.90 ok");
  });

  it("caps mask overlays at 1280 px and tells the model how to convert coordinates", async () => {
    const { ctx, photo } = await seed({ width: 1600, height: 1200 });
    await addSegment(photo.id, 1600, 1200);

    const overlay = await run("view_photo", { photo_id: photo.id, with_masks: true }, ctx);
    const meta = await sharp(Buffer.from(overlay.images![0]!.dataUrl.split(",")[1]!, "base64")).metadata();
    expect([meta.width, meta.height]).toEqual([OVERLAY_MAX_EDGE_PX, 960]);
    expect(overlay.output).toMatchObject({ width: 1600, height: 1200, shown_width: 1280, shown_height: 960 });
    expect((overlay.output as { coordinate_note: string }).coordinate_note).toMatch(/multiply what you read off this image by 1\.25/);

    const plain = await run("view_photo", { photo_id: photo.id }, ctx);
    expect((await sharp(Buffer.from(plain.images![0]!.dataUrl.split(",")[1]!, "base64")).metadata()).width).toBe(1600);
  });
});

describe("5. context compaction", () => {
  it("replaces a verified photo's images with a decision summary and re-sends only on a new view_photo", async () => {
    const { visitId, photo } = await seed();
    script(
      [
        () => call(["segment_photo", { photo_id: photo.id, targets: ["column"] }]),
        () => call(["view_photo", { photo_id: photo.id, with_masks: true }]),
        (input) => {
          const legend = toolOutputs(input).at(-1).mask_legend as { segment_id: number }[];
          return call([
            "verify_segments",
            {
              photo_id: photo.id,
              decisions: [
                { segment_id: legend[0]!.segment_id, keep: true, reason: "formwork marks visible" },
                { segment_id: legend[1]!.segment_id, keep: false, reason: "scaffolding pole" },
              ],
            },
          ]);
        },
        () => call(["list_boq_items", {}]),
        () => call(["view_photo", { photo_id: photo.id, with_masks: true }]),
        () => call(["finish", { summary: "done" }]),
      ],
      { "concrete column": SAM_TWO },
    );

    await runAgent(visitId);

    expect(inputs.map(images)).toEqual([0, 0, 1, 0, 0, 1]); // image in context only while it is needed
    const placeholder = texts(inputs[3]!).find((t) => t.startsWith(`[photo ${photo.id} image removed`))!;
    expect(placeholder).toMatch(new RegExp(`^\\[photo ${photo.id} image removed — verified: kept \\d+; rejected \\d+ \\(scaffolding pole\\)\\. Call view_photo again to see it\\.\\]$`));

    const { steps } = await stepsOfLatestRun(visitId);
    const modelImages = steps.filter((s) => s.kind === "model").map((s) => (s.payload as { context: { images: number } }).context.images);
    expect(modelImages).toEqual([0, 0, 1, 0, 0, 1]); // logged per step
    expect(steps.some((s) => s.kind === "notice" && s.name === "context_compacted")).toBe(true);
  });
});

describe("6. graceful wrap-up", () => {
  it("counts model turns only, warns 4 turns before the end, and ends 'partial' keeping assessments", async () => {
    const { visitId, item, photo } = await seed();
    expect(env.MAX_AGENT_STEPS).toBe(10);
    // Never calls finish. Records one assessment once the wrap-up message appears.
    script([
      (input) =>
        texts(input).includes(WRAP_UP) && !toolOutputs(input).some((o) => o.assessment_id)
          ? call([
              "record_assessment",
              { boq_item_id: item.id, percent_complete: 30, confidence: 0.4, rationale: "partial evidence", evidence: [{ photo_id: photo.id, segment_ids: [] }] },
            ])
          : call(["list_boq_items", {}], ["list_photos", {}], ["list_boq_items", {}]), // 3 tool calls, 1 model turn
    ]);

    await expect(runAgent(visitId)).resolves.toBe("partial");

    expect(inputs).toHaveLength(10); // 10 model turns although 3 tool calls per turn
    const firstWithWrapUp = inputs.findIndex((inp) => texts(inp).includes(WRAP_UP));
    expect(firstWithWrapUp).toBe(10 - WRAP_UP_TURNS); // sent before turn 7 of 10
    expect(texts(inputs.at(-1)!).filter((t) => t === WRAP_UP)).toHaveLength(1); // only once

    const { run: latest, steps } = await stepsOfLatestRun(visitId);
    expect(latest.status).toBe("partial");
    expect(latest.error).toBeNull();
    const [visit] = await db.select().from(schema.visits).where(eq(schema.visits.id, visitId));
    expect(visit!.status).toBe("assessed"); // reviewable
    expect(await db.select().from(schema.assessments).where(eq(schema.assessments.visitId, visitId))).toHaveLength(1);
    expect(steps.filter((s) => s.kind === "notice").map((s) => s.name)).toEqual(["wrap_up", "step_budget"]);
    expect((steps.at(-1)!.payload as { message: string }).message).toBe("Used all 10 model turns without finish; kept 1 recorded assessment(s).");
    expect(steps.filter((s) => s.kind === "tool_result").length).toBeGreaterThan(20);
  });
});

describe("7. fast path (AGENT_FAST_PATH)", () => {
  const withFastPath = async (on: boolean, fn: () => Promise<void>) => {
    const before = env.AGENT_FAST_PATH;
    env.AGENT_FAST_PATH = on;
    try {
      await fn();
    } finally {
      env.AGENT_FAST_PATH = before;
    }
  };
  const toolNames = () => (create.mock.calls.find(([b]) => b.model !== env.SAM_MODEL)![0] as { tools: { name: string }[] }).tools.map((t) => t.name);
  async function addVisualItem(projectId: number) {
    const [item] = await db
      .insert(schema.boqItems)
      .values({ projectId, code: "2.1", description: "Plaster", unit: "m2", plannedQty: 40, measureMode: "visual_only" })
      .returning();
    return item!;
  }
  const assessment = (boqItemId: number, photoId: number, extra: Record<string, unknown> = {}) => ({
    boq_item_id: boqItemId,
    percent_complete: 40,
    confidence: 0.65,
    rationale: "visible in the photo",
    evidence: [{ photo_id: photoId }],
    ...extra,
  });

  it("off: no pre-segmentation, no record_assessments tool, same behaviour as before", async () => {
    await withFastPath(false, async () => {
      const { ctx, visitId } = await seed();
      script([() => call(["finish", { summary: "done" }])], { "concrete column": SAM_TWO });
      expect(await runAgent(visitId)).toBe("assessed");
      expect(create.mock.calls.filter(([b]) => b.model === env.SAM_MODEL)).toHaveLength(0);
      expect(images(inputs[0]!)).toBe(0);
      expect(toolNames()).not.toContain("record_assessments");
      expect(errorOf(await run("record_assessments", { items: [] }, ctx))).toMatch(/^Unknown tool "record_assessments"/);
    });
  });

  it("on: segments every photo for the BOQ's targets before turn 1 and attaches the masked overlay", async () => {
    await withFastPath(true, async () => {
      const { visitId, photo } = await seed();
      let samBeforeFirstTurn = 0;
      script(
        [
          () => {
            samBeforeFirstTurn = create.mock.calls.filter(([b]) => b.model === env.SAM_MODEL).length;
            return call(["finish", { summary: "done" }]);
          },
        ],
        { "concrete column": SAM_TWO },
      );
      expect(await runAgent(visitId)).toBe("assessed");
      expect(samBeforeFirstTurn).toBe(1); // one target (column), one prompt
      const first = inputs[0]!;
      expect(images(first)).toBe(1);
      const ctxText = texts(first)[0]!;
      expect(ctxText).toMatch(/Pre-segmentation \(done by code before this turn, fast path\) for targets column/);
      const segs = await db.select().from(schema.segments).where(eq(schema.segments.photoId, photo.id));
      expect(segs).toHaveLength(2);
      for (const s of segs) expect(ctxText).toContain(`"segment_id": ${s.id}`);
      expect(toolNames()).toContain("record_assessments");
      const { steps } = await stepsOfLatestRun(visitId);
      expect(steps.slice(0, 5).map((s) => `${s.kind}:${s.name}`)).toEqual([
        "tool_call:segment_photo",
        "tool_result:segment_photo",
        "tool_call:view_photo",
        "tool_result:view_photo",
        "notice:pre_segmented",
      ]);
    });
  });

  it("record_assessments: items succeed or fail independently; finish waits while any failed", async () => {
    await withFastPath(true, async () => {
      const { visitId, photo, item, ctx } = await seed();
      const plaster = await addVisualItem(ctx.projectId);
      const batch1 = [
        assessment(item.id, photo.id),
        assessment(999_999, photo.id), // unknown item
        { boq_item_id: plaster.id, rationale: "no confidence", evidence: [{ photo_id: photo.id }] }, // invalid
      ];
      let firstResult: { recorded: number; failed: number; results: { index: number; ok: boolean; error?: string }[] } | undefined;
      script([
        () => call(["record_assessments", { items: batch1 }], ["finish", { summary: "too early" }]),
        (input) => {
          firstResult = toolOutputs(input)[0];
          return call(["record_assessments", { items: [assessment(plaster.id, photo.id)] }], ["finish", { summary: "done" }]);
        },
      ]);
      expect(await runAgent(visitId)).toBe("assessed");
      expect(inputs).toHaveLength(2); // finish ran in the same turn as the second batch
      expect(firstResult).toMatchObject({ recorded: 1, failed: 2 });
      expect(firstResult!.results.map((r) => r.ok)).toEqual([true, false, false]);
      expect(firstResult!.results[1]!.error).toMatch(/boq_item_id 999999 not found/);
      expect(firstResult!.results[2]!.error).toMatch(/^Invalid arguments: confidence/);
      const refusedFinish = toolOutputs(inputs[1]!)[1];
      expect(refusedFinish.error).toMatch(/^2 item\(s\) in this turn's record_assessments failed/);
      const rows = await db.select().from(schema.assessments).where(eq(schema.assessments.visitId, visitId));
      expect(rows.map((r) => r.boqItemId).sort()).toEqual([item.id, plaster.id].sort());
      // Visual-only caps still apply per item.
      expect(rows.find((r) => r.boqItemId === plaster.id)!.confidence).toBeLessThanOrEqual(env.VISUAL_ONLY_MAX_CONFIDENCE);
      // Each item also shows up as its own record_assessment in the trace.
      const { steps } = await stepsOfLatestRun(visitId);
      expect(steps.filter((s) => s.kind === "tool_result" && s.name === "record_assessment")).toHaveLength(4);
    });
  });
});

describe("8. count items without a quantity", () => {
  const rec = (boqItemId: number, photoId: number, extra: Record<string, unknown>) => ({
    boq_item_id: boqItemId,
    confidence: 0.8,
    rationale: "r",
    evidence: [{ photo_id: photoId }],
    ...extra,
  });
  const qtyOf = async (visitId: number, boqItemId: number) =>
    (await db.select().from(schema.assessments).where(eq(schema.assessments.visitId, visitId))).find((a) => a.boqItemId === boqItemId)!.qtyDone;

  it("0% → qty_done 0; otherwise percent × planned_qty rounded down, flagged as derived", async () => {
    const { ctx, visitId, photo, item } = await seed(); // count item, planned 10 nos
    const zero = (await run("record_assessment", rec(item.id, photo.id, { percent_complete: 0 }), ctx)).output as { qty_done: number; qty_basis: string; notes: string[] };
    expect(zero.qty_done).toBe(0);
    expect(zero.qty_basis).toBe("derived: 0% × 10 nos (planned_qty), rounded down = 0 nos");
    expect(zero.notes.some((n) => n.startsWith("qty_done was not given, so it was derived from percent_complete (0 nos)"))).toBe(true);
    expect(await qtyOf(visitId, item.id)).toBe(0);

    const some = (await run("record_assessment", rec(item.id, photo.id, { percent_complete: 37 }), ctx)).output as { qty_done: number };
    expect(some.qty_done).toBe(3); // 3.7 rounded down
    expect(await qtyOf(visitId, item.id)).toBe(3);
  });

  it("keeps a counted qty_done as given", async () => {
    const { ctx, visitId, photo, item } = await seed();
    const out = (await run("record_assessment", rec(item.id, photo.id, { percent_complete: 50, qty_done: 4 }), ctx)).output as { qty_done: number; qty_basis?: string };
    expect(out.qty_done).toBe(4);
    expect(out.qty_basis).toBeUndefined();
    expect(await qtyOf(visitId, item.id)).toBe(4);
  });
});
