/** Drawing imports in the database: create (rasterise + store pages + queue), run (as a worker job), load. */
import { and, eq, sql as dsql } from "drizzle-orm";
import sharp from "sharp";
import { BoqProposal, PageClassification, SheetExtraction, type DrawingImport } from "@sitesight/shared";
import { env } from "../../config.js";
import { db, schema } from "../../db/client.js";
import { enqueue } from "../jobs.js";
import { getObject, newKey, presignGet, putObject } from "../storage.js";
import { assembleProposal, runActions } from "./assemble.js";
import { ImportCostMeter } from "./cost.js";
import { rasterizePdf } from "./rasterize.js";
import { isStructural, runPipeline, type PageState } from "./pipeline.js";

export const DRAWING_MAX_BYTES = 25 * 1024 * 1024;
export const PAGE_MAX_EDGE = 2000;
const THUMB_EDGE = 480;

/** Rasterise the PDF, store each page (PNG + thumbnail), record the import and queue the Spark work. */
export async function createDrawingImport(projectId: number, fileName: string, pdf: Buffer): Promise<number> {
  const pages = await rasterizePdf(pdf, { maxEdge: PAGE_MAX_EDGE, maxPages: env.DRAWING_MAX_PAGES });
  const [imp] = await db.insert(schema.drawingImports).values({ projectId, fileName }).returning();
  for (const p of pages) {
    const storageKey = newKey(`projects/${projectId}/drawings/${imp!.id}`, "image/png");
    const thumbKey = newKey(`projects/${projectId}/drawings/${imp!.id}/thumbs`, "image/png");
    const thumb = await sharp(p.png).resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: "inside" }).png().toBuffer();
    await putObject(storageKey, p.png, "image/png");
    await putObject(thumbKey, thumb, "image/png");
    await db.insert(schema.drawingPages).values({ projectId, importId: imp!.id, pageNo: p.pageNo, storageKey, thumbKey, width: p.width, height: p.height });
  }
  await enqueue("drawing_import", { importId: imp!.id });
  return imp!.id;
}

/** The worker's job: classify + extract (resuming pages done by an earlier attempt), then assemble the proposal. */
export async function runDrawingImport(importId: number): Promise<DrawingImport["status"]> {
  const [imp] = await db.select().from(schema.drawingImports).where(eq(schema.drawingImports.id, importId));
  if (!imp) throw new Error(`drawing import ${importId} not found`);
  await db.update(schema.drawingImports).set({ status: "processing", error: null }).where(eq(schema.drawingImports.id, importId));
  const rows = await db.select().from(schema.drawingPages).where(eq(schema.drawingPages.importId, importId)).orderBy(schema.drawingPages.pageNo);
  const keyOf = new Map(rows.map((r) => [r.pageNo, r.storageKey]));
  const pageWhere = (pageNo: number) => and(eq(schema.drawingPages.importId, importId), eq(schema.drawingPages.pageNo, pageNo));

  const states: PageState[] = rows.map((r) => ({
    pageNo: r.pageNo,
    classification: r.classification ? PageClassification.parse(r.classification) : null,
    extraction: r.extraction ? SheetExtraction.parse(r.extraction) : null,
    error: r.error,
  }));

  const meter = new ImportCostMeter(env.MAX_COST_PER_DRAWING_IMPORT_USD, imp.costUsd, async (u) => {
    await db
      .update(schema.drawingImports)
      .set({
        costUsd: dsql`${schema.drawingImports.costUsd} + ${u.costUsd}`,
        inputTokens: dsql`${schema.drawingImports.inputTokens} + ${u.inputTokens}`,
        outputTokens: dsql`${schema.drawingImports.outputTokens} + ${u.outputTokens}`,
      })
      .where(eq(schema.drawingImports.id, importId));
  });

  const { stoppedByCost } = await runPipeline(
    states,
    {
      png: async (pageNo) => getObject(keyOf.get(pageNo)!),
      onClassified: (pageNo, c) =>
        db.update(schema.drawingPages).set({ classification: c, sheetType: c.sheet_type, titleGuess: c.title, status: "classified", error: null }).where(pageWhere(pageNo)).then(() => {}),
      onSkipped: (pageNo) => db.update(schema.drawingPages).set({ status: "skipped" }).where(pageWhere(pageNo)).then(() => {}),
      onExtracted: (pageNo, e) => db.update(schema.drawingPages).set({ extraction: e, status: "extracted", error: null }).where(pageWhere(pageNo)).then(() => {}),
      onFailed: (pageNo, error) => db.update(schema.drawingPages).set({ status: "failed", error }).where(pageWhere(pageNo)).then(() => {}),
    },
    meter,
    env.DRAWING_CONCURRENCY,
  );

  const proposal = assembleProposal(states.map((s) => ({ pageNo: s.pageNo, classification: s.classification, extraction: s.extraction })));
  proposal.warnings.unshift(...runActions(states, stoppedByCost, env.MAX_COST_PER_DRAWING_IMPORT_USD, isStructural));
  const status = stoppedByCost ? "cost_limit" : "done";
  await db.update(schema.drawingImports).set({ status, proposal }).where(eq(schema.drawingImports.id, importId));
  return status;
}

export async function markDrawingImportFailed(importId: number, error: string): Promise<void> {
  await db.update(schema.drawingImports).set({ status: "failed", error }).where(eq(schema.drawingImports.id, importId));
}

export async function loadDrawingImport(projectId: number, importId: number): Promise<DrawingImport | null> {
  const [imp] = await db
    .select()
    .from(schema.drawingImports)
    .where(and(eq(schema.drawingImports.id, importId), eq(schema.drawingImports.projectId, projectId)));
  if (!imp) return null;
  const pages = await db.select().from(schema.drawingPages).where(eq(schema.drawingPages.importId, importId)).orderBy(schema.drawingPages.pageNo);
  return {
    id: imp.id,
    projectId: imp.projectId,
    fileName: imp.fileName,
    status: imp.status,
    costUsd: Math.round(imp.costUsd * 10000) / 10000,
    costLimitUsd: env.MAX_COST_PER_DRAWING_IMPORT_USD,
    error: imp.error,
    proposal: imp.proposal ? BoqProposal.parse(imp.proposal) : null,
    pages: await Promise.all(
      pages.map(async (p) => ({
        id: p.id,
        pageNo: p.pageNo,
        status: p.status,
        sheetType: (p.sheetType as DrawingImport["pages"][number]["sheetType"]) ?? null,
        titleGuess: p.titleGuess,
        width: p.width,
        height: p.height,
        error: p.error,
        imageUrl: await presignGet(p.storageKey),
        thumbUrl: await presignGet(p.thumbKey),
      })),
    ),
  };
}
