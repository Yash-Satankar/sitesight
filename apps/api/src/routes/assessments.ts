import { Router } from "express";
import { eq } from "drizzle-orm";
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
  if (!["assessed", "reviewed", "needs_input"].includes(visit.status)) {
    throw new HttpError(409, `Cannot review while visit is ${visit.status}`);
  }

  const update =
    body.action === "accept"
      ? { status: "accepted" as const, engineerNote: body.engineerNote ?? a.engineerNote }
      : {
          status: "edited" as const,
          percentComplete: body.percentComplete ?? a.percentComplete,
          qtyDone: body.qtyDone !== undefined ? body.qtyDone : a.qtyDone,
          engineerNote: body.engineerNote ?? a.engineerNote,
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
