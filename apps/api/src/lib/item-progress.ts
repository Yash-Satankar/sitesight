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
 * Planned-qty-weighted average of each item's latest confirmed percent (unconfirmed items count as 0).
 * Null when no item has a planned quantity. Inferred items count, and are reported separately.
 */
export function overallPercent(
  items: { id: number; plannedQty: number }[],
  assessments: Map<number, ItemAssessments> | undefined,
): { overallPercent: number | null; inferredItems: number } {
  let weight = 0;
  let sum = 0;
  let inferredItems = 0;
  for (const it of items) {
    const confirmed = assessments?.get(it.id)?.confirmed;
    if (confirmed?.basis === "inferred") inferredItems++;
    if (!(it.plannedQty > 0)) continue;
    weight += it.plannedQty;
    sum += it.plannedQty * (confirmed?.percentComplete ?? 0);
  }
  return { overallPercent: weight > 0 ? Math.round((sum / weight) * 10) / 10 : null, inferredItems };
}
