import { eq, inArray } from "drizzle-orm";
import { progressRows, type Assessment, type ProgressInput, type VisitProgress } from "@sitesight/shared";
import { db, schema } from "../db/client.js";
import { boqItemStatus } from "./item-status.js";

type VisitRow = typeof schema.visits.$inferSelect;
type AskBackRow = { id: number; boqItemId: number | null };

/**
 * Counts for the visit summary card plus the "progress since last visit" table from the dry run.
 * The previous visit is the latest earlier visit of the project (by date, then id) that has assessments.
 */
export async function loadVisitProgress(visit: VisitRow, assessments: Assessment[], openAskBacks: AskBackRow[]): Promise<VisitProgress> {
  const items = await db.select().from(schema.boqItems).where(eq(schema.boqItems.projectId, visit.projectId)).orderBy(schema.boqItems.id);
  const byItem = new Map(assessments.map((a) => [a.boqItemId, a]));
  const openFor = (itemId: number) => openAskBacks.filter((a) => a.boqItemId === itemId).map((a) => a.id);

  let assessed = 0;
  let inferred = 0;
  let awaitingPhoto = 0;
  const now: ProgressInput[] = items.map((it) => {
    const a = byItem.get(it.id);
    if (a) a.basis === "inferred" ? inferred++ : assessed++;
    else if (openFor(it.id).length) awaitingPhoto++;
    return {
      code: it.code,
      description: it.description,
      status: boqItemStatus(!!a, openFor(it.id), a?.basis),
      assessment: a ? { percentComplete: a.percentComplete, stageReached: a.stageReached } : null,
    };
  });

  const previousVisit = await findPreviousAssessedVisit(visit);
  let sinceLastVisit: VisitProgress["sinceLastVisit"] = [];
  if (previousVisit) {
    const prevRows = await db.select().from(schema.assessments).where(eq(schema.assessments.visitId, previousVisit.id));
    const prevByItem = new Map(prevRows.map((a) => [a.boqItemId, a]));
    const previous: ProgressInput[] = items.map((it) => {
      const a = prevByItem.get(it.id);
      return {
        code: it.code,
        description: it.description,
        status: boqItemStatus(!!a, [], a?.basis),
        assessment: a ? { percentComplete: a.percentComplete, stageReached: a.stageReached } : null,
      };
    });
    sinceLastVisit = progressRows(previous, now);
  }

  return {
    totalItems: items.length,
    assessed,
    inferred,
    awaitingPhoto,
    notAssessed: items.length - assessed - inferred - awaitingPhoto,
    previousVisit: previousVisit ? { id: previousVisit.id, visitDate: previousVisit.visitDate } : null,
    sinceLastVisit,
  };
}

async function findPreviousAssessedVisit(visit: VisitRow): Promise<VisitRow | null> {
  const visits = await db.select().from(schema.visits).where(eq(schema.visits.projectId, visit.projectId));
  const earlier = visits
    .filter((v) => v.visitDate < visit.visitDate || (v.visitDate === visit.visitDate && v.id < visit.id))
    .sort((a, b) => (a.visitDate === b.visitDate ? b.id - a.id : a.visitDate < b.visitDate ? 1 : -1));
  if (!earlier.length) return null;
  const withAssessments = new Set(
    (
      await db
        .select({ visitId: schema.assessments.visitId })
        .from(schema.assessments)
        .where(inArray(schema.assessments.visitId, earlier.map((v) => v.id)))
    ).map((r) => r.visitId),
  );
  return earlier.find((v) => withAssessments.has(v.id)) ?? null;
}
