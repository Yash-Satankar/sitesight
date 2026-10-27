import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { FulfilAskBackBody } from "@sitesight/shared";
import { db, schema } from "../db/client.js";
import { HttpError, intParam, notFound, parse } from "../lib/http.js";
import { countOpenAskBacks, getVisitOr404 } from "../lib/queries.js";
import { queueAgentRun } from "./visits.js";

export const askBacksRouter = Router();

async function getOpenAskBack(id: number) {
  const [ab] = await db.select().from(schema.askBacks).where(eq(schema.askBacks.id, id));
  if (!ab) notFound("Ask-back");
  if (ab.status !== "open") throw new HttpError(409, `Ask-back is already ${ab.status}`);
  return ab;
}

/** When the last open ask-back is resolved, the agent resumes with a new run. */
async function resumeIfReady(visitId: number): Promise<boolean> {
  const visit = await getVisitOr404(visitId);
  if (visit.status !== "needs_input" || (await countOpenAskBacks(visitId)) > 0) return false;
  await queueAgentRun(visitId);
  return true;
}

askBacksRouter.post("/ask-backs/:id/fulfil", async (req, res) => {
  const ab = await getOpenAskBack(intParam(req.params.id));
  const { photoId } = parse(FulfilAskBackBody, req.body);
  const [photo] = await db
    .select()
    .from(schema.photos)
    .where(and(eq(schema.photos.id, photoId), eq(schema.photos.visitId, ab.visitId)));
  if (!photo) throw new HttpError(400, "Photo not in this visit");

  await db.transaction(async (tx) => {
    await tx.update(schema.photos).set({ askBackId: ab.id }).where(eq(schema.photos.id, photo.id));
    await tx.update(schema.askBacks).set({ status: "fulfilled" }).where(eq(schema.askBacks.id, ab.id));
  });
  res.json({ status: "fulfilled", resumed: await resumeIfReady(ab.visitId) });
});

askBacksRouter.post("/ask-backs/:id/skip", async (req, res) => {
  const ab = await getOpenAskBack(intParam(req.params.id));
  await db.update(schema.askBacks).set({ status: "skipped" }).where(eq(schema.askBacks.id, ab.id));
  res.json({ status: "skipped", resumed: await resumeIfReady(ab.visitId) });
});
