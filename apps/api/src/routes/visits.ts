import { Router } from "express";
import { eq } from "drizzle-orm";
import { CreateVisitBody } from "@sitesight/shared";
import { db, schema } from "../db/client.js";
import { HttpError, intParam, notFound, parse } from "../lib/http.js";
import { countOpenAskBacks, getVisitOr404, loadVisitDetail, toVisitSummary } from "../lib/queries.js";
import { enqueue } from "../services/jobs.js";

export const visitsRouter = Router();

visitsRouter.post("/projects/:id/visits", async (req, res) => {
  const projectId = intParam(req.params.id);
  const body = parse(CreateVisitBody, req.body ?? {});
  const [p] = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId));
  if (!p) notFound("Project");
  const [v] = await db
    .insert(schema.visits)
    .values({ projectId, ...(body.visitDate ? { visitDate: body.visitDate } : {}) })
    .returning();
  res.status(201).json(toVisitSummary(v!));
});

visitsRouter.get("/visits/:id", async (req, res) => {
  res.json(await loadVisitDetail(intParam(req.params.id)));
});

visitsRouter.post("/visits/:id/run", async (req, res) => {
  const visitId = intParam(req.params.id);
  const visit = await getVisitOr404(visitId);
  if (visit.status === "queued" || visit.status === "processing") throw new HttpError(409, "Visit is already running");
  if ((await countOpenAskBacks(visitId)) > 0) throw new HttpError(409, "Resolve open photo requests first");
  const photos = await db.select({ id: schema.photos.id }).from(schema.photos).where(eq(schema.photos.visitId, visitId));
  if (!photos.length) throw new HttpError(400, "Upload at least one photo first");

  await queueAgentRun(visitId);
  res.status(202).json({ status: "queued" });
});

export async function queueAgentRun(visitId: number) {
  await db.update(schema.visits).set({ status: "queued" }).where(eq(schema.visits.id, visitId));
  await enqueue("agent_run", { visitId });
}
