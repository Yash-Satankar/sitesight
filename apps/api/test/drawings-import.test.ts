/**
 * BOQ from drawings: rasterising, Spark JSON validation + retry, the pipeline (skips, failures, cost cap), the upload
 * route and the import job, and the agent seeing each item's drawing source. Spark is faked at the SDK client.
 */
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { store, fake } = vi.hoisted(() => ({
  store: new Map<string, Buffer>(),
  fake: { calls: [] as { instructions: string; input: unknown[] }[], reply: (_req: { instructions: string; input: any[] }): string => "{}" },
}));

vi.mock("../src/meta/client.js", () => ({
  metaClient: () => ({
    responses: {
      create: async (req: { instructions: string; input: any[] }) => {
        fake.calls.push({ instructions: req.instructions, input: structuredClone(req.input) });
        return { output_text: fake.reply(req), output: [], usage: { input_tokens: 200, output_tokens: 200 } }; // $0.004 per call
      },
    },
  }),
}));
vi.mock("../src/db/client.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("../src/db/schema.js");
  return { db: drizzle(new PGlite(), { schema }), schema, sql: { end: async () => {} } };
});
vi.mock("../src/services/storage.js", () => ({
  getObject: async (key: string) => {
    const v = store.get(key);
    if (!v) throw new Error(`no object ${key}`);
    return v;
  },
  putObject: async (key: string, body: Buffer) => void store.set(key, body),
  presignGet: async (key: string) => `/storage/${key}`,
  newKey: (prefix: string) => `${prefix}/${Math.random().toString(36).slice(2)}`,
}));

import express from "express";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { PageClassification } from "@sitesight/shared";
import { db as mockedDb, schema } from "../src/db/client.js";
import { drawingsRouter } from "../src/routes/drawings.js";
import { boqRouter } from "../src/routes/boq.js";
import { errorHandler } from "../src/lib/http.js";
import { JsonValidationError, respondJsonContent } from "../src/meta/spark.js";
import { pdfPageCount, PdfError, rasterizePdf } from "../src/services/drawings/rasterize.js";
import { ImportCostMeter } from "../src/services/drawings/cost.js";
import { runPipeline, type PageState } from "../src/services/drawings/pipeline.js";
import { runDrawingImport } from "../src/services/drawings/imports.js";
import { CLASSIFY_INSTRUCTIONS } from "../src/services/drawings/prompts.js";
import { runTool } from "../src/agent/tools.js";

const db = mockedDb as unknown as PgliteDatabase<typeof schema>;

/** A PDF whose pages have the given pdfkit sizes, each with a title and a black box. */
async function makePdf(pages: { size: string | [number, number]; layout?: "portrait" | "landscape"; title: string }[]): Promise<Buffer> {
  const doc = new PDFDocument({ autoFirstPage: false });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  for (const p of pages) {
    doc.addPage({ size: p.size, layout: p.layout ?? "portrait" });
    doc.fontSize(28).fillColor("#000").text(p.title, 40, 40);
    doc.rect(100, 150, 60, 60).fill("#000");
  }
  doc.end();
  await new Promise((r) => doc.on("end", r));
  return Buffer.concat(chunks);
}

/** Width × height of the PNG in an input_image data URL (from the IHDR chunk). */
function imageSize(input: any[]): string {
  const url: string = input[0].content.find((c: { type: string }) => c.type === "input_image").image_url;
  const png = Buffer.from(url.split(",")[1]!, "base64");
  return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
}

describe("rasterizePdf", () => {
  it("renders each page to a PNG with the long edge at most 2000 px", async () => {
    const pdf = await makePdf([
      { size: "A3", layout: "landscape", title: "COLUMN LAYOUT" },
      { size: "A4", title: "SCHEDULE" },
    ]);
    expect(await pdfPageCount(pdf)).toBe(2);
    const pages = await rasterizePdf(pdf, { maxEdge: 2000 });
    expect(pages.map((p) => [p.pageNo, p.width, p.height])).toEqual([
      [1, 2000, 1414],
      [2, 1414, 2000],
    ]);
    // The black box is drawn: a pixel inside it is dark, a corner is white.
    const { data, info } = await sharp(pages[0]!.png).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => data[(y * info.width + x) * info.channels]!;
    const s = 2000 / 1190.55; // A3 landscape width in points
    expect(px(Math.round(130 * s), Math.round(180 * s))).toBeLessThan(50);
    expect(px(5, 1400)).toBeGreaterThan(240);
  });

  it("refuses non-PDFs and too many pages", async () => {
    await expect(rasterizePdf(Buffer.from("hello"))).rejects.toBeInstanceOf(PdfError);
    const pdf = await makePdf([{ size: "A5", title: "1" }, { size: "A5", title: "2" }]);
    await expect(rasterizePdf(pdf, { maxPages: 1 })).rejects.toThrow("has 2 pages; the limit is 1");
  });
});

describe("respondJsonContent", () => {
  beforeEach(() => (fake.calls = []));

  it("sends the zod issues back and retries once", async () => {
    let n = 0;
    fake.reply = () => (++n === 1 ? '{"sheet_type":"roof_plan","title":"Roof"}' : '{"sheet_type":"slab_plan","title":"Roof slab"}');
    const meter = new ImportCostMeter(1);
    const { data, attempts } = await respondJsonContent(PageClassification, { instructions: "x", content: [{ type: "input_text", text: "hi" }], meter });
    expect(data).toMatchObject({ sheet_type: "slab_plan", title: "Roof slab" });
    expect(attempts).toBe(2);
    const retry = fake.calls[1]!.input.at(-1) as { content: string };
    expect(retry.content).toMatch(/does not match the schema:\n- sheet_type: Invalid enum value/);
    expect(meter.calls).toBe(2);
    expect(meter.spentUsd).toBeCloseTo(0.008);
  });

  it("gives up after the retry with the issues", async () => {
    fake.reply = () => "no json here";
    await expect(respondJsonContent(PageClassification, { instructions: "x", content: [{ type: "input_text", text: "hi" }] })).rejects.toBeInstanceOf(JsonValidationError);
    expect(fake.calls).toHaveLength(2);
  });
});

// ---- scripted Spark for whole drawing sets: classification by page size, extraction by "Page N" ----
const CLASSES: Record<string, PageClassification> = {
  "2000x1414": { sheet_type: "column_layout", title: "Column layout plan", notes: "", shows_masonry_walls: false, title_block_title: null },
  "1414x2000": { sheet_type: "footing_column_schedule", title: "Column schedule", notes: "", shows_masonry_walls: false, title_block_title: null },
  "1545x2000": { sheet_type: "electrical", title: "Electrical layout", notes: "", shows_masonry_walls: false, title_block_title: null },
};
const EXTRACTIONS: Record<number, object> = {
  1: { layout_counts: [{ element: "column", mark: "C1", count: 2, floor: null, evidence_text: "counted 2 C1", confidence: 0.8 }, { element: "column", mark: "C2", count: 9, floor: null, evidence_text: "counted 9 C2", confidence: 0.7 }] },
  2: { columns: [{ mark: "C1", size_text: '9"x9"', count: 2, floor: null, evidence_text: "C1 9x9 2 NOS", confidence: 0.9 }, { mark: "C2", size_text: '9"x18"', count: 10, floor: null, evidence_text: "C2 9x18 10 NOS", confidence: 0.9 }] },
};
function scripted(req: { instructions: string; input: any[] }): string {
  if (req.instructions === CLASSIFY_INSTRUCTIONS) {
    const c = CLASSES[imageSize(req.input)];
    if (!c) throw new Error(`unexpected page size ${imageSize(req.input)}`);
    return JSON.stringify(c);
  }
  const pageNo = Number(/Page (\d+)/.exec(req.input[0].content[0].text)![1]);
  return JSON.stringify(EXTRACTIONS[pageNo] ?? {});
}
const pdfSet = () =>
  makePdf([
    { size: "A3", layout: "landscape", title: "COLUMN LAYOUT PLAN" },
    { size: "A4", title: "COLUMN SCHEDULE" },
    { size: "LETTER", title: "ELECTRICAL" },
  ]);

describe("runPipeline", () => {
  let pngs: Buffer[] = [];
  beforeAll(async () => {
    pngs = (await rasterizePdf(await pdfSet())).map((p) => p.png);
  });
  beforeEach(() => {
    fake.calls = [];
    fake.reply = scripted;
  });
  const fresh = (): PageState[] => pngs.map((_, i) => ({ pageNo: i + 1, classification: null, extraction: null, error: null }));

  it("classifies every page and extracts only structural sheets", async () => {
    const skipped: number[] = [];
    const { pages, stoppedByCost } = await runPipeline(fresh(), { png: async (n) => pngs[n - 1]!, onSkipped: (n) => void skipped.push(n) }, new ImportCostMeter(1));
    expect(stoppedByCost).toBe(false);
    expect(pages.map((p) => [p.classification?.sheet_type, !!p.extraction])).toEqual([
      ["column_layout", true],
      ["footing_column_schedule", true],
      ["electrical", false],
    ]);
    expect(skipped).toEqual([3]);
    expect(fake.calls).toHaveLength(5); // 3 classifications + 2 extractions
  });

  it("keeps going when one page fails", async () => {
    fake.reply = (req) => (req.instructions !== CLASSIFY_INSTRUCTIONS && /Page 2/.test(req.input[0].content[0].text) ? "garbage" : scripted(req));
    const failed: number[] = [];
    const { pages } = await runPipeline(fresh(), { png: async (n) => pngs[n - 1]!, onFailed: (n) => void failed.push(n) }, new ImportCostMeter(1));
    expect(failed).toEqual([2]);
    expect(pages[1]!.error).toMatch(/invalid JSON after one retry/);
    expect(pages[0]!.extraction).not.toBeNull();
  });

  it("stops starting calls at the cost cap and reports it", async () => {
    // $0.004 per call; a $0.01 cap allows at most 3 calls with concurrency 1.
    const meter = new ImportCostMeter(0.01);
    const { pages, stoppedByCost } = await runPipeline(fresh(), { png: async (n) => pngs[n - 1]! }, meter, 1);
    expect(stoppedByCost).toBe(true);
    expect(meter.calls).toBe(3);
    expect(meter.spentUsd).toBeCloseTo(0.012);
    expect(pages.filter((p) => p.extraction)).toHaveLength(0);
  });
});

describe("POST /projects/:id/drawings + import job", () => {
  let base = "";
  let close = () => {};
  let projectId = 0;

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../src/db/migrations", import.meta.url)) });
    projectId = (await db.insert(schema.projects).values({ name: "P" }).returning())[0]!.id;
    const server = express().use(express.json()).use(drawingsRouter).use(boqRouter).use(errorHandler).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());
  beforeEach(() => {
    fake.calls = [];
    fake.reply = scripted;
  });

  const upload = async (bytes: Buffer, name = "set.pdf") => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), name);
    const res = await fetch(`${base}/projects/${projectId}/drawings`, { method: "POST", body: form });
    return { status: res.status, body: await res.json() };
  };

  it("stores each page and its thumbnail, and queues the import", async () => {
    const { status, body } = await upload(await pdfSet());
    expect(status).toBe(201);
    expect(body).toMatchObject({ projectId, fileName: "set.pdf", status: "queued", costUsd: 0, proposal: null });
    expect(body.pages.map((p: { pageNo: number; width: number; height: number; status: string }) => [p.pageNo, p.width, p.height, p.status])).toEqual([
      [1, 2000, 1414, "pending"],
      [2, 1414, 2000, "pending"],
      [3, 1545, 2000, "pending"],
    ]);
    const thumbKey = body.pages[0].thumbUrl.replace("/storage/", "");
    expect((await sharp(store.get(thumbKey)!).metadata()).width).toBe(480);
    const jobs = await db.select().from(schema.jobs).where(eq(schema.jobs.kind, "drawing_import"));
    expect(jobs.map((j) => j.payload)).toEqual([{ importId: body.id }]);
  });

  it("rejects non-PDFs and files over 25 MB", async () => {
    expect((await upload(Buffer.from("not a pdf"), "x.pdf")).status).toBe(400);
    const big = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(25 * 1024 * 1024 + 10)]);
    const res = await upload(big);
    expect(res.status).toBe(413);
    expect(res.body.error).toBe("The PDF is larger than 25 MB");
  });

  it("the job classifies, extracts and stores the proposal with the discrepancy and the cost", async () => {
    const { body } = await upload(await pdfSet());
    expect(await runDrawingImport(body.id)).toBe("done");
    const imp = await (await fetch(`${base}/projects/${projectId}/drawings/${body.id}`)).json();
    expect(imp.status).toBe("done");
    expect(imp.costUsd).toBeCloseTo(0.02); // 5 calls × $0.004
    // …and each call is in the spend ledger, against the project.
    const rows = (await db.select().from(schema.spendLedger)).filter((r) => r.kind === "drawing_import" && r.projectId === projectId);
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(rows.reduce((sum, r) => sum + r.costUsd, 0)).toBeGreaterThanOrEqual(0.02 - 1e-9);
    expect(imp.pages.map((p: { status: string; sheetType: string }) => [p.status, p.sheetType])).toEqual([
      ["extracted", "column_layout"],
      ["extracted", "footing_column_schedule"],
      ["skipped", "electrical"],
    ]);
    expect(imp.proposal.discrepancies).toHaveLength(1);
    expect(imp.proposal.discrepancies[0].message).toBe("Column C2: the schedule (p.2) says 10, the layout (p.1) shows 9.");
    expect(imp.proposal.items[0]).toMatchObject({ code: "COL", plannedQty: 0, needsInput: "drawing discrepancy for C2" });

    // Running the job again (e.g. a worker retry) resumes: no new Spark calls for pages already done.
    fake.calls = [];
    await runDrawingImport(body.id);
    expect(fake.calls).toHaveLength(0);
  });

  it("stops at the cost cap with a partial proposal", async () => {
    const { body } = await upload(await pdfSet());
    await db.update(schema.drawingImports).set({ costUsd: 5 }).where(eq(schema.drawingImports.id, body.id)); // already over $1
    expect(await runDrawingImport(body.id)).toBe("cost_limit");
    const imp = await (await fetch(`${base}/projects/${projectId}/drawings/${body.id}`)).json();
    expect(imp.proposal.warnings[0]).toEqual({ kind: "action", text: "Stopped at the cost cap ($1.00): pp. 1, 2, 3 not read. The proposal covers the rest.", pages: [1, 2, 3] });
    expect(fake.calls).toHaveLength(0);
  });

  it("saves drawing sources with the BOQ, and the agent sees them", async () => {
    const res = await fetch(`${base}/projects/${projectId}/boq`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ code: "COL", description: "RCC columns", unit: "nos", plannedQty: 12, measureMode: "count", segmentTargets: ["column"], drawingSource: "12 nos per Column schedule p.2" }],
      }),
    });
    expect(res.status).toBe(200);
    const [visit] = await db.insert(schema.visits).values({ projectId }).returning();
    const out = await runTool("list_boq_items", "{}", { runId: 0, visitId: visit!.id, projectId });
    expect(out.output).toEqual([expect.objectContaining({ code: "COL", planned_qty: 12, drawing_source: "12 nos per Column schedule p.2" })]);
  });
});
