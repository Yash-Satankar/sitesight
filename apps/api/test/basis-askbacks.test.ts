/**
 * Evidence basis (observed vs inferred) and ask-back dedupe / cross-visit fulfilment.
 * Meta mocked, PGlite with real migrations, in-memory storage.
 */
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { INFERRED_STATUS } from "@sitesight/shared";

const { create, store } = vi.hoisted(() => ({ create: vi.fn(), store: new Map<string, Buffer>() }));

vi.mock("../src/meta/client.js", () => ({ metaClient: () => ({ responses: { create } }) }));
vi.mock("../src/db/client.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const schema = await import("../src/db/schema.js");
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../src/db/migrations", import.meta.url)) });
  return { db, schema, sql: { end: async () => {} } };
});
vi.mock("../src/services/storage.js", () => {
  let n = 0;
  return {
    getObject: async (key: string) => store.get(key)!,
    putObject: async (key: string, body: Buffer) => void store.set(key, body),
    presignGet: async (key: string) => `file:///${key}`,
    presignPut: async () => {
      throw new Error("no presign in tests");
    },
    newKey: (prefix: string) => `${prefix}/${++n}`,
  };
});

import type { PgliteDatabase } from "drizzle-orm/pglite";
import { db as mockedDb, schema } from "../src/db/client.js";
import { INFERRED_MAX_CONFIDENCE, runTool, type ToolContext } from "../src/agent/tools.js";
import { runAgent } from "../src/agent/run.js";
import { systemPrompt } from "../src/agent/prompts.js";
import { boqItemStatus } from "../src/lib/item-status.js";
import { billLines, buildReport, type ReportItem } from "../src/services/report.js";
import { assertAskBackOpenInProject, fulfilAskBack } from "../src/services/ask-backs.js";
import { runDryRun } from "../scripts/dry-run.js";

const db = mockedDb as unknown as PgliteDatabase<typeof schema>;

// ---- fixtures: Demo-Residence-style project, two visits ----
async function seed() {
  const [project] = await db.insert(schema.projects).values({ name: "P" }).returning();
  const [zone] = await db.insert(schema.zones).values({ projectId: project!.id, name: "GF" }).returning();
  const visit = async (status: "draft" | "needs_input" = "draft") => (await db.insert(schema.visits).values({ projectId: project!.id, status }).returning())[0]!;
  const v1 = await visit();
  const v2 = await visit();
  const photo = async (visitId: number) =>
    (await db.insert(schema.photos).values({ visitId, zoneId: zone!.id, storageKey: `k${visitId}-${Math.random()}`, width: 10, height: 10 }).returning())[0]!;
  const p1 = await photo(v1.id);
  const p2 = await photo(v2.id);
  const ctxFor = async (visitId: number): Promise<ToolContext> => {
    const [run] = await db.insert(schema.agentRuns).values({ visitId }).returning();
    return { runId: run!.id, visitId, projectId: project!.id };
  };
  const item = async (code: string, sequenceNo: number | null, extra: Partial<typeof schema.boqItems.$inferInsert> = {}) =>
    (
      await db
        .insert(schema.boqItems)
        .values({ projectId: project!.id, code, description: code, unit: "nos", plannedQty: 10, measureMode: "visual_only", sequenceNo, ...extra })
        .returning()
    )[0]!;
  const footing = await item("FTG-1", 1);
  const plinth = await item("PB-1", 2, { unit: "lot", plannedQty: 1 });
  const loose = await item("MISC", null);
  return { projectId: project!.id, zoneId: zone!.id, v1, v2, p1, p2, ctx1: await ctxFor(v1.id), ctx2: await ctxFor(v2.id), footing, plinth, loose, item };
}

const run = (name: string, args: unknown, ctx: ToolContext) => runTool(name, JSON.stringify(args), ctx);
const out = (o: { output: unknown }) => o.output as Record<string, unknown>;
const record = (ctx: ToolContext, itemId: number, photoId: number, extra: Record<string, unknown>) =>
  run("record_assessment", { boq_item_id: itemId, percent_complete: 100, confidence: 0.8, rationale: "seen", evidence: [{ photo_id: photoId, segment_ids: [] }], ...extra }, ctx);

// Braces matter: a function returned from beforeEach is run by vitest as a cleanup hook (mockReset returns the mock).
beforeEach(() => {
  create.mockReset();
});

// ---------------------------------------------------------------------------------------------

describe("1. evidence basis", () => {
  it("refuses 'inferred' without an observed later-sequence item in this visit", async () => {
    const { ctx2, p2, footing, plinth } = await seed();
    expect(out(await record(ctx2, footing.id, p2.id, { basis: "inferred", rationale: "under PB-1" })).error).toMatch(
      /basis "inferred" is only allowed when an item later in the sequence \(sequence_no > 1\) has been recorded as observed in this visit, and none has/,
    );
    // An observed item EARLIER in the sequence does not count.
    await record(ctx2, footing.id, p2.id, { rationale: "footings visible" });
    expect(out(await record(ctx2, plinth.id, p2.id, { basis: "inferred", rationale: "FTG-1 is done" })).error).toMatch(/sequence_no > 2/);
  });

  it("allows 'inferred' below an observed later item; rationale must name it; confidence capped", async () => {
    const { ctx2, p2, footing, plinth } = await seed();
    await record(ctx2, plinth.id, p2.id, { rationale: "Plinth beam cast all round." });

    expect(out(await record(ctx2, footing.id, p2.id, { basis: "inferred", rationale: "Footings must be done." })).error).toBe(
      "The rationale of an inferred assessment must name the observed item it is inferred from: one of PB-1.",
    );

    const ok = await record(ctx2, footing.id, p2.id, { basis: "inferred", confidence: 0.9, rationale: "Footings are buried; pb-1 is cast over them." });
    expect(out(ok)).toMatchObject({ basis: "inferred", confidence: INFERRED_MAX_CONFIDENCE });
    expect(JSON.stringify(out(ok).notes)).toContain(`Recorded as ${INFERRED_STATUS}.`);
    const [a] = await db.select().from(schema.assessments).where(eq(schema.assessments.id, out(ok).assessment_id as number));
    expect(a!.basis).toBe("inferred");
  });

  it("defaults to observed; refuses inferred for items without a sequence number or with measurements", async () => {
    const { ctx2, p2, plinth, loose, footing } = await seed();
    const obs = await record(ctx2, plinth.id, p2.id, {});
    expect(out(obs).basis).toBe("observed");
    expect(out(await record(ctx2, loose.id, p2.id, { basis: "inferred", rationale: "PB-1" })).error).toMatch(/MISC has no sequence number/);
    expect(out(await record(ctx2, footing.id, p2.id, { basis: "inferred", rationale: "PB-1", panel_measurement_ids: [1] })).error).toMatch(
      /cannot cite panel measurements/,
    );
  });

  it("status, bill lines and PDF keep inferred work out of the bill", async () => {
    expect(boqItemStatus(true, [], "inferred")).toBe(INFERRED_STATUS);
    expect(boqItemStatus(true, [4], "inferred")).toBe(`${INFERRED_STATUS} (ask-back #4 open)`);

    const base = { unit: "nos", plannedQty: 10, confidence: 0.5, status: "accepted", engineerNote: null, evidence: [] };
    const items: ReportItem[] = [
      { ...base, code: "PB-1", description: "Plinth beams", percentComplete: 100, qtyDone: 1, rationale: "cast", basis: "observed" },
      { ...base, code: "FTG-1", description: "Footings", percentComplete: 100, qtyDone: 10, rationale: "under PB-1", basis: "inferred" },
    ];
    expect(billLines(items).map((l) => l.code)).toEqual(["PB-1"]);

    const pdf = await buildReport({ projectName: "P", locationLabel: "", visitDate: "2026-10-29", items, compress: false });
    const text = [...pdf.toString("latin1").matchAll(/<([0-9a-f]+)>/gi)].map((m) => Buffer.from(m[1]!, "hex").toString("latin1")).join("");
    const bill = text.slice(text.indexOf("Bill summary"), text.indexOf("PB-1  Plinth beams", text.indexOf("billable item")));
    expect(bill).toContain("PB-1  Plinth beams: 1 nos (100%)");
    expect(bill).not.toContain("FTG-1");
    expect(bill).toContain("1 billable item(s). 1 inferred item(s) excluded until observed");
    expect(text).toContain("Inferred work (inferred");
    expect(text).toContain("not billable until observed)");
    expect(text.indexOf("FTG-1  Footings")).toBeGreaterThan(text.indexOf("Inferred work"));
  });

  it("prompt prefers observed evidence and limits 'inferred' to hidden earlier-sequence work", () => {
    expect(systemPrompt()).toMatch(/prefer observed evidence/);
    expect(systemPrompt()).toMatch(/Use basis "inferred" only for hidden earlier-sequence work/);
  });
});

describe("2. ask-back dedupe and cross-visit fulfilment", () => {
  it("reuses an open ask-back for the same item, in this visit or an earlier one", async () => {
    const { ctx1, ctx2, zoneId, footing, plinth } = await seed();
    const ask = (ctx: ToolContext, boq_item_id?: number) =>
      run("request_photo", { zone_id: zoneId, boq_item_id, instruction: "Square-on photo of the plinth beam along grid A", reason: "hidden" }, ctx);

    const first = out(await ask(ctx1, footing.id));
    expect(first).toMatchObject({ status: "open" });
    expect(first.reused).toBeUndefined();
    expect(out(await ask(ctx1, footing.id))).toMatchObject({ ask_back_id: first.ask_back_id, reused: true, note: expect.stringMatching(/earlier in this visit/) });
    expect(out(await ask(ctx2, footing.id))).toMatchObject({ ask_back_id: first.ask_back_id, reused: true, note: expect.stringMatching(/on the visit of \d{4}-\d{2}-\d{2}/) });
    expect(out(await ask(ctx2, plinth.id)).ask_back_id).not.toBe(first.ask_back_id); // other item → new request
    expect(await db.select().from(schema.askBacks).where(eq(schema.askBacks.boqItemId, footing.id))).toHaveLength(1);
  });

  it("refuses a boq_item_id from another project", async () => {
    const a = await seed();
    const b = await seed();
    expect(out(await run("request_photo", { zone_id: a.zoneId, boq_item_id: b.footing.id, instruction: "Square-on photo of the bay", reason: "r" }, a.ctx1)).error).toMatch(
      /not found in this project/,
    );
  });

  it("lists open ask-backs from earlier visits in the agent's starting context", async () => {
    const { ctx1, v2, zoneId, footing } = await seed();
    await run("request_photo", { zone_id: zoneId, boq_item_id: footing.id, instruction: "Square-on photo of footing F1 before backfill", reason: "r" }, ctx1);
    let firstInput = "";
    create.mockImplementation(async (body: { input: { content: unknown }[] }) => {
      firstInput = String(body.input[0]!.content);
      return { id: "r", output: [{ type: "function_call", id: "f", call_id: "c", name: "finish", arguments: '{"summary":"x"}', status: "completed" }], output_text: "", usage: { input_tokens: 1, output_tokens: 1 } };
    });
    await runAgent(v2.id);
    const ctx = JSON.parse(firstInput.split("Visit context:\n")[1]!);
    expect(ctx.open_ask_backs_from_earlier_visits).toEqual([
      expect.objectContaining({ boq_item_id: footing.id, instruction: "Square-on photo of footing F1 before backfill" }),
    ]);
  });

  it("a photo from a later visit fulfils an earlier visit's ask-back and closes that visit out", async () => {
    const { ctx1, v1, p1, p2, zoneId, footing } = await seed();
    const ab = out(await run("request_photo", { zone_id: zoneId, boq_item_id: footing.id, instruction: "Square-on photo of footing F1", reason: "r" }, ctx1))
      .ask_back_id as number;
    await db.update(schema.visits).set({ status: "needs_input" }).where(eq(schema.visits.id, v1.id));
    await assertAskBackOpenInProject(ab, p2.visitId); // registering a v2 photo against it is allowed

    expect(await fulfilAskBack(ab, p2.id)).toEqual({ status: "fulfilled", resumed: false, closedEarlierVisit: true });
    expect((await db.select().from(schema.askBacks).where(eq(schema.askBacks.id, ab)))[0]!.status).toBe("fulfilled");
    expect((await db.select().from(schema.photos).where(eq(schema.photos.id, p2.id)))[0]!.askBackId).toBe(ab);
    expect((await db.select().from(schema.visits).where(eq(schema.visits.id, v1.id)))[0]!.status).toBe("assessed"); // not re-run
    expect(await db.select().from(schema.jobs).where(eq(schema.jobs.kind, "agent_run"))).toHaveLength(0);
    void p1;
  });

  it("a photo from the same visit still resumes that visit; photos from other projects are refused", async () => {
    const a = await seed();
    const ab = out(await run("request_photo", { zone_id: a.zoneId, boq_item_id: a.footing.id, instruction: "Square-on photo of footing F1", reason: "r" }, a.ctx1))
      .ask_back_id as number;
    await db.update(schema.visits).set({ status: "needs_input" }).where(eq(schema.visits.id, a.v1.id));
    const other = await seed();
    await expect(fulfilAskBack(ab, other.p1.id)).rejects.toThrow(/Photo not in this project/);
    await expect(assertAskBackOpenInProject(ab, other.v1.id)).rejects.toThrow(/Ask-back not in this project/);

    expect(await fulfilAskBack(ab, a.p1.id)).toEqual({ status: "fulfilled", resumed: true, closedEarlierVisit: false });
    expect((await db.select().from(schema.visits).where(eq(schema.visits.id, a.v1.id)))[0]!.status).toBe("queued");
  });
});

describe("dry run shows inferred items distinctly", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "sitesight-basis-"));
    await mkdir(join(root, "v1"));
    await writeFile(join(root, "v1", "a.jpg"), await sharp({ create: { width: 64, height: 64, channels: 3, background: "#888" } }).jpeg().toBuffer());
  });

  it("table and JSON report mark inferred work as not billable", async () => {
    type Body = { input: { type?: string; output?: string; content?: unknown }[] };
    const outputs = (b: Body) => b.input.filter((i) => i.type === "function_call_output").map((i) => JSON.parse(i.output!));
    const photoId = (b: Body) => JSON.parse(String(b.input[0]!.content).split("Visit context:\n")[1]!).photos[0].photo_id;
    const idOf = (b: Body, code: string) => (outputs(b)[0] as { boq_item_id: number; code: string }[]).find((i) => i.code === code)!.boq_item_id;
    let step = 0;
    const fc = (name: string, args: unknown) => ({
      id: `r${step}`,
      output: [{ type: "function_call", id: `f${step}`, call_id: `c${step}`, name, arguments: JSON.stringify(args), status: "completed" }],
      output_text: "",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const script = [
      () => fc("list_boq_items", {}),
      (b: Body) => fc("record_assessment", { boq_item_id: idOf(b, "PB-1"), percent_complete: 100, confidence: 0.6, rationale: "Plinth beams cast.", evidence: [{ photo_id: photoId(b), segment_ids: [] }] }),
      (b: Body) =>
        fc("record_assessment", {
          boq_item_id: idOf(b, "FTG-1"),
          basis: "inferred",
          percent_complete: 100,
          confidence: 0.6,
          rationale: "Footings hidden under PB-1.",
          evidence: [{ photo_id: photoId(b), segment_ids: [] }],
        }),
      () => fc("finish", { summary: "done" }),
    ];
    create.mockImplementation(async (body: Body) => script[step++]!(body));

    const lines: string[] = [];
    const result = await runDryRun({
      visitDirs: [join(root, "v1")],
      boqPath: fileURLToPath(new URL("../../../samples/boq-demo-residence.json", import.meta.url)),
      outDir: root,
      out: (l) => lines.push(l),
    });
    const text = lines.join("\n");
    expect(text).toMatch(/FTG-1 RCC footings.*\| inferred — not billable until observed +\| 100%/);
    expect(text).toMatch(/PB-1 Plinth beams.*\| assessed +\| 100%/);
    expect(result.visits[0]!.assessments.find((a) => a.code === "FTG-1")).toMatchObject({ basis: "inferred", confidence: 0.5 });
    const report = JSON.parse(await readFile(join(root, "dry-run.json"), "utf8"));
    expect(report.visits[0].items.find((i: { code: string }) => i.code === "FTG-1").status).toBe(INFERRED_STATUS);
  });
});
