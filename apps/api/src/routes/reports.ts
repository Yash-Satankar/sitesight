import { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";
import type { ReportResponse } from "@sitesight/shared";
import { db, schema } from "../db/client.js";
import { HttpError, intParam } from "../lib/http.js";
import { getVisitOr404, loadAssessments } from "../lib/queries.js";
import { loadNormalizedPhoto } from "../services/images.js";
import { drawMasks } from "../services/overlay.js";
import { buildReport, type ReportItem } from "../services/report.js";
import { pendingItems } from "../lib/item-status.js";
import { getObject, newKey, presignGet, putObject } from "../services/storage.js";

export const reportsRouter = Router();

reportsRouter.post("/visits/:id/report", async (req, res) => {
  const visitId = intParam(req.params.id);
  const visit = await getVisitOr404(visitId);
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, visit.projectId));
  const items = await db.select().from(schema.boqItems).where(eq(schema.boqItems.projectId, visit.projectId));
  const allAssessments = await loadAssessments(visitId);
  const confirmed = allAssessments.filter((a) => a.status !== "proposed");
  // Items still waiting for a requested photo are listed in their own section of the report.
  const askBacks = await db.select().from(schema.askBacks).where(eq(schema.askBacks.visitId, visitId));
  const pending = pendingItems(items, new Set(allAssessments.map((a) => a.boqItemId)), askBacks);
  if (!confirmed.length) throw new HttpError(409, "Accept or edit at least one assessment before generating a report");

  const photoIds = [...new Set(confirmed.flatMap((a) => a.evidence.map((e) => e.photoId)))];
  const photos = photoIds.length ? await db.select().from(schema.photos).where(inArray(schema.photos.id, photoIds)) : [];

  const reportItems: ReportItem[] = [];
  for (const a of confirmed) {
    const item = items.find((i) => i.id === a.boqItemId);
    if (!item) continue;
    const evidence: Buffer[] = [];
    for (const ev of a.evidence.slice(0, 3)) {
      const photo = photos.find((p) => p.id === ev.photoId);
      if (!photo) continue;
      const img = await loadNormalizedPhoto(photo.storageKey);
      if (!ev.segmentIds.length) {
        evidence.push(img.buffer);
        continue;
      }
      const segs = await db
        .select()
        .from(schema.segments)
        .where(and(eq(schema.segments.photoId, photo.id), inArray(schema.segments.id, ev.segmentIds)));
      const masks = await Promise.all(segs.map(async (s) => ({ mask: await getObject(s.maskKey), bbox: s.bbox, label: `#${s.id}` })));
      evidence.push(await drawMasks(img.buffer, masks));
    }
    reportItems.push({
      code: item.code,
      description: item.description,
      unit: item.unit,
      plannedQty: item.plannedQty,
      percentComplete: a.percentComplete,
      qtyDone: a.qtyDone,
      confidence: a.confidence,
      rationale: a.rationale,
      status: a.status,
      engineerNote: a.engineerNote,
      basis: a.basis,
      evidence,
    });
  }
  reportItems.sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }));

  const pdf = await buildReport({
    projectName: project!.name,
    locationLabel: project!.locationLabel,
    visitDate: visit.visitDate,
    items: reportItems,
    pending,
  });
  const storageKey = newKey(`visits/${visitId}/reports`, "application/pdf");
  await putObject(storageKey, pdf, "application/pdf");
  const [report] = await db.insert(schema.reports).values({ visitId, storageKey }).returning();
  if (visit.status === "reviewed") {
    await db.update(schema.visits).set({ status: "reported" }).where(eq(schema.visits.id, visitId));
  }

  const body: ReportResponse = { reportId: report!.id, downloadUrl: await presignGet(storageKey) };
  res.status(201).json(body);
});
