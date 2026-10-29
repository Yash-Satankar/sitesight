import { Router } from "express";
import { and, desc, eq, gte } from "drizzle-orm";
import { PatchAssessmentBody } from "@sitesight/shared";
import { db, schema } from "../db/client.js";
import { HttpError, intParam, notFound, parse } from "../lib/http.js";
import { getVisitOr404 } from "../lib/queries.js";

export const assessmentsRouter = Router();

assessmentsRouter.patch("/assessments/:id", async (req, res) => {
  const id = intParam(req.params.id);
  const body = parse(PatchAssessmentBody, req.body);
  const [a] = await db.select().from(schema.assessments).where(eq(schema.assessments.id, id));
  if (!a) notFound("Assessment");
  const visit = await getVisitOr404(a.visitId);

  if ("status" in body) {
    // Undo: back to "proposed", unless a report generated since the review already includes it.
    if (a.status === "proposed") return void res.json(a);
    const [report] = await db
      .select({ id: schema.reports.id, createdAt: schema.reports.createdAt })
      .from(schema.reports)
      .where(and(eq(schema.reports.visitId, visit.id), a.reviewedAt ? gte(schema.reports.createdAt, a.reviewedAt) : undefined))
      .orderBy(desc(schema.reports.createdAt))
      .limit(1);
    if (report) {
      throw new HttpError(
        409,
        `Can't undo: report #${report.id} (${report.createdAt.toISOString().slice(0, 10)}) was generated after this assessment was ${a.status}, so it already includes it.`,
      );
    }
    if (!["assessed", "reviewed", "needs_input"].includes(visit.status)) {
      throw new HttpError(409, `Cannot undo while visit is ${visit.status}`);
    }
    const [reverted] = await db
      .update(schema.assessments)
      .set({ status: "proposed", reviewedAt: null })
      .where(eq(schema.assessments.id, id))
      .returning();
    // Something is unreviewed again.
    if (visit.status === "reviewed") await db.update(schema.visits).set({ status: "assessed" }).where(eq(schema.visits.id, visit.id));
    return void res.json(reverted);
  }

  if (!["assessed", "reviewed", "needs_input"].includes(visit.status)) {
    throw new HttpError(409, `Cannot review while visit is ${visit.status}`);
  }

  const update =
    body.action === "accept"
      ? { status: "accepted" as const, engineerNote: body.engineerNote ?? a.engineerNote, reviewedAt: new Date() }
      : {
          status: "edited" as const,
          percentComplete: body.percentComplete ?? a.percentComplete,
          qtyDone: body.qtyDone !== undefined ? body.qtyDone : a.qtyDone,
          engineerNote: body.engineerNote ?? a.engineerNote,
          reviewedAt: new Date(),
        };
  const [updated] = await db.update(schema.assessments).set(update).where(eq(schema.assessments.id, id)).returning();

  // Once every assessment is reviewed, the visit moves to "reviewed".
  if (visit.status === "assessed") {
    const all = await db.select({ status: schema.assessments.status }).from(schema.assessments).where(eq(schema.assessments.visitId, visit.id));
    if (all.every((x) => x.status !== "proposed")) {
      await db.update(schema.visits).set({ status: "reviewed" }).where(eq(schema.visits.id, visit.id));
    }
  }
  res.json(updated);
});
