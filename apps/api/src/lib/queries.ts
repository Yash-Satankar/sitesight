import { and, eq, inArray, ne } from "drizzle-orm";
import type { Assessment, AskBack, EarlierAskBack, Photo, VisitDetail, VisitSummary } from "@sitesight/shared";
import { db, schema } from "../db/client.js";
import { presignGet } from "../services/storage.js";
import { notFound } from "./http.js";

type VisitRow = typeof schema.visits.$inferSelect;

export function toVisitSummary(v: VisitRow): VisitSummary {
  return { id: v.id, projectId: v.projectId, visitDate: v.visitDate, status: v.status, createdAt: v.createdAt.toISOString() };
}

export async function getVisitOr404(visitId: number): Promise<VisitRow> {
  const [v] = await db.select().from(schema.visits).where(eq(schema.visits.id, visitId));
  return v ?? notFound("Visit");
}

export async function loadAssessments(visitId: number): Promise<Assessment[]> {
  const rows = await db.select().from(schema.assessments).where(eq(schema.assessments.visitId, visitId));
  const ids = rows.map((r) => r.id);
  const ev = ids.length
    ? await db.select().from(schema.assessmentEvidence).where(inArray(schema.assessmentEvidence.assessmentId, ids))
    : [];
  const panelIds = [...new Set(rows.flatMap((r) => r.panelMeasurementIds))];
  const panels = panelIds.length
    ? await db
        .select({ id: schema.panelMeasurements.id, photoId: schema.panelMeasurements.photoId, fraction: schema.panelMeasurements.fraction })
        .from(schema.panelMeasurements)
        .where(inArray(schema.panelMeasurements.id, panelIds))
    : [];
  return rows.map((a) => ({
    id: a.id,
    visitId: a.visitId,
    boqItemId: a.boqItemId,
    percentComplete: a.percentComplete,
    qtyDone: a.qtyDone,
    confidence: a.confidence,
    rationale: a.rationale,
    deviation: a.deviation,
    status: a.status,
    engineerNote: a.engineerNote,
    basis: a.basis,
    evidence: ev.filter((e) => e.assessmentId === a.id).map((e) => ({ photoId: e.photoId, segmentIds: e.segmentIds })),
    panels: panels.filter((p) => a.panelMeasurementIds.includes(p.id)),
  }));
}

export async function loadVisitDetail(visitId: number): Promise<VisitDetail> {
  const visit = await getVisitOr404(visitId);
  const photoRows = await db.select().from(schema.photos).where(eq(schema.photos.visitId, visitId)).orderBy(schema.photos.id);
  const photos: Photo[] = await Promise.all(
    photoRows.map(async (p) => ({
      id: p.id,
      visitId: p.visitId,
      zoneId: p.zoneId,
      storageKey: p.storageKey,
      width: p.width,
      height: p.height,
      transcript: p.transcript,
      askBackId: p.askBackId,
      url: await presignGet(p.storageKey).catch(() => undefined),
    })),
  );
  const askBacks: AskBack[] = (
    await db.select().from(schema.askBacks).where(eq(schema.askBacks.visitId, visitId)).orderBy(schema.askBacks.id)
  ).map((a) => ({
    id: a.id,
    visitId: a.visitId,
    zoneId: a.zoneId,
    boqItemId: a.boqItemId,
    instruction: a.instruction,
    reason: a.reason,
    status: a.status,
  }));
  // Requests still open from earlier visits of this project: a photo taken in this visit can answer them.
  const earlierOpenAskBacks: EarlierAskBack[] = (
    await db
      .select({ a: schema.askBacks, visitDate: schema.visits.visitDate })
      .from(schema.askBacks)
      .innerJoin(schema.visits, eq(schema.visits.id, schema.askBacks.visitId))
      .where(and(eq(schema.visits.projectId, visit.projectId), ne(schema.askBacks.visitId, visitId), eq(schema.askBacks.status, "open")))
      .orderBy(schema.askBacks.id)
  ).map(({ a, visitDate }) => ({
    id: a.id,
    visitId: a.visitId,
    zoneId: a.zoneId,
    boqItemId: a.boqItemId,
    instruction: a.instruction,
    reason: a.reason,
    status: a.status,
    visitDate,
  }));
  return { ...toVisitSummary(visit), photos, assessments: await loadAssessments(visitId), askBacks, earlierOpenAskBacks };
}

export async function countOpenAskBacks(visitId: number): Promise<number> {
  const rows = await db
    .select({ id: schema.askBacks.id })
    .from(schema.askBacks)
    .where(and(eq(schema.askBacks.visitId, visitId), eq(schema.askBacks.status, "open")));
  return rows.length;
}

/** Ask-backs still open anywhere in the project (a request from an earlier visit can still block an item). */
export async function openAskBacksForProject(projectId: number) {
  return (
    await db
      .select({ a: schema.askBacks })
      .from(schema.askBacks)
      .innerJoin(schema.visits, eq(schema.visits.id, schema.askBacks.visitId))
      .where(and(eq(schema.visits.projectId, projectId), eq(schema.askBacks.status, "open")))
      .orderBy(schema.askBacks.id)
  ).map(({ a }) => a);
}
