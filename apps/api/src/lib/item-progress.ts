import { desc, eq, inArray } from "drizzle-orm";
import type { ItemAssessmentSummary } from "@sitesight/shared";
import { db, schema } from "../db/client.js";

export interface ItemAssessments {
  /** Latest accepted/edited assessment: what counts as progress. */
  confirmed: ItemAssessmentSummary | null;
  /** Newest assessment of any status (can be a proposed one still to review). */
  latest: ItemAssessmentSummary;
}

/** Per project id → per BOQ item id: its latest confirmed and latest-of-any-status assessments (newest visit wins). */
export async function itemAssessmentsByProject(projectIds: number[]): Promise<Map<number, Map<number, ItemAssessments>>> {
  const out = new Map<number, Map<number, ItemAssessments>>();
  if (!projectIds.length) return out;
  const rows = await db
    .select({ a: schema.assessments, projectId: schema.visits.projectId, visitDate: schema.visits.visitDate })
    .from(schema.assessments)
    .innerJoin(schema.visits, eq(schema.visits.id, schema.assessments.visitId))
    .where(inArray(schema.visits.projectId, projectIds))
    .orderBy(desc(schema.visits.visitDate), desc(schema.visits.id));
  for (const { a, projectId, visitDate } of rows) {
    const summary: ItemAssessmentSummary = {
      assessmentId: a.id,
      visitId: a.visitId,
      visitDate,
      percentComplete: a.percentComplete,
      stageReached: a.stageReached,
      basis: a.basis,
      status: a.status,
    };
    const items = out.get(projectId) ?? new Map<number, ItemAssessments>();
    out.set(projectId, items);
    const entry = items.get(a.boqItemId);
    const confirmed = a.status === "accepted" || a.status === "edited";
    if (!entry) items.set(a.boqItemId, { latest: summary, confirmed: confirmed ? summary : null });
    else if (confirmed && !entry.confirmed) entry.confirmed = summary;
  }
  return out;
}

/**
 * Mean of each item's latest confirmed percent, every item counting equally (unconfirmed items count as 0).
 * Null when the project has no BOQ items. Inferred items count, and are reported separately.
 */
export function overallPercent(
  items: { id: number }[],
  assessments: Map<number, ItemAssessments> | undefined,
): { overallPercent: number | null; inferredItems: number } {
  let sum = 0;
  let inferredItems = 0;
  for (const it of items) {
    const confirmed = assessments?.get(it.id)?.confirmed;
    if (confirmed?.basis === "inferred") inferredItems++;
    sum += confirmed?.percentComplete ?? 0;
  }
  return { overallPercent: items.length ? Math.round((sum / items.length) * 10) / 10 : null, inferredItems };
}
