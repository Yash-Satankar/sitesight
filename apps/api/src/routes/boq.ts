import { Router } from "express";
import multer from "multer";
import { eq } from "drizzle-orm";
import { SaveBoqBody, type ParsedBoqResponse } from "@sitesight/shared";
import { db, schema } from "../db/client.js";
import { HttpError, intParam, notFound, parse } from "../lib/http.js";
import { parseBoq } from "../services/boq-parser.js";
import { boqItemProblem } from "../services/boq-rules.js";

export const boqRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/** Parse an uploaded .xlsx and return items for review. Nothing is saved yet. */
boqRouter.post("/projects/:id/boq", upload.single("file"), async (req, res) => {
  intParam(req.params.id);
  if (!req.file) throw new HttpError(400, 'Upload the .xlsx as multipart field "file"');
  if (!/\.xlsx$/i.test(req.file.originalname)) throw new HttpError(400, "Only .xlsx files are supported");
  const result: ParsedBoqResponse = await parseBoq(req.file.buffer);
  res.json(result);
});

/**
 * Save reviewed items, replacing the project's BOQ.
 * Replacing deletes old items (and cascades to their assessments), so do this before visits are assessed.
 */
boqRouter.put("/projects/:id/boq", async (req, res) => {
  const projectId = intParam(req.params.id);
  const { items } = parse(SaveBoqBody, req.body);
  const problems = items.flatMap((it) => {
    const p = boqItemProblem(it);
    return p ? [`${it.code}: ${p}`] : [];
  });
  if (problems.length) throw new HttpError(400, "Inconsistent BOQ items", problems);
  const [p] = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId));
  if (!p) notFound("Project");

  const saved = await db.transaction(async (tx) => {
    await tx.delete(schema.boqItems).where(eq(schema.boqItems.projectId, projectId));
    if (!items.length) return [];
    return tx
      .insert(schema.boqItems)
      .values(items.map((it) => ({ ...it, projectId })))
      .returning();
  });
  res.json(saved);
});
