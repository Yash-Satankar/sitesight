import { Router, type RequestHandler } from "express";
import multer from "multer";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { HttpError, intParam, notFound } from "../lib/http.js";
import { createDrawingImport, DRAWING_MAX_BYTES, loadDrawingImport } from "../services/drawings/imports.js";
import { PdfError } from "../services/drawings/rasterize.js";

export const drawingsRouter = Router();

const multerUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: DRAWING_MAX_BYTES } }).single("file");
/** multer, with a readable 413 instead of a 500 when the file is too big. */
const upload: RequestHandler = (req, res, next) =>
  multerUpload(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") return next(new HttpError(413, "The PDF is larger than 25 MB"));
    next(err);
  });

/** Upload a drawing set (PDF ≤ 25 MB): pages are rasterised and stored now; Spark reads them in the worker. */
drawingsRouter.post("/projects/:id/drawings", upload, async (req, res) => {
  const projectId = intParam(req.params.id);
  const [p] = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId));
  if (!p) notFound("Project");
  if (!req.file) throw new HttpError(400, 'Upload the PDF as multipart field "file"');
  if (req.file.buffer.subarray(0, 5).toString("latin1") !== "%PDF-") throw new HttpError(400, "Only PDF drawings are supported");
  let importId: number;
  try {
    importId = await createDrawingImport(projectId, req.file.originalname, req.file.buffer);
  } catch (err) {
    if (err instanceof PdfError) throw new HttpError(400, err.message);
    throw err;
  }
  res.status(201).json(await loadDrawingImport(projectId, importId));
});

/** Progress per page, cost so far, and the proposed BOQ once assembled. Poll while status is queued/processing. */
drawingsRouter.get("/projects/:id/drawings/:importId", async (req, res) => {
  const imp = await loadDrawingImport(intParam(req.params.id), intParam(req.params.importId, "importId"));
  if (!imp) notFound("Drawing import");
  res.json(imp);
});

/** Imports of a project, newest first (ids and status only). */
drawingsRouter.get("/projects/:id/drawings", async (req, res) => {
  const projectId = intParam(req.params.id);
  const rows = await db
    .select({ id: schema.drawingImports.id, fileName: schema.drawingImports.fileName, status: schema.drawingImports.status, createdAt: schema.drawingImports.createdAt })
    .from(schema.drawingImports)
    .where(eq(schema.drawingImports.projectId, projectId))
    .orderBy(desc(schema.drawingImports.id));
  res.json(rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })));
});
