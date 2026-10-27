import { and, eq, inArray } from "drizzle-orm";
import type { Assessment, AskBack, Photo, VisitDetail, VisitSummary } from "@sitesight/shared";
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
    evidence: ev.filter((e) => e.assessmentId === a.id).map((e) => ({ photoId: e.photoId, segmentIds: e.segmentIds })),
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
  return { ...toVisitSummary(visit), photos, assessments: await loadAssessments(visitId), askBacks };
}

export async function countOpenAskBacks(visitId: number): Promise<number> {
  const rows = await db
    .select({ id: schema.askBacks.id })
    .from(schema.askBacks)
    .where(and(eq(schema.askBacks.visitId, visitId), eq(schema.askBacks.status, "open")));
  return rows.length;
}
