import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { HttpError, notFound } from "../lib/http.js";
import { countOpenAskBacks, getVisitOr404 } from "../lib/queries.js";
import { queueAgentRun } from "./jobs.js";
import { overDailyCap } from "../lib/spend.js";

export interface AskBackResolution {
  status: "fulfilled" | "skipped";
  /** The ask-back's own visit was re-queued for a new agent run. */
  resumed: boolean;
  /** The ask-back came from an earlier visit; that visit was closed out instead of re-run. */
  closedEarlierVisit: boolean;
}

async function getOpenAskBack(id: number) {
  const [ab] = await db.select().from(schema.askBacks).where(eq(schema.askBacks.id, id));
  if (!ab) notFound("Ask-back");
  if (ab.status !== "open") throw new HttpError(409, `Ask-back is already ${ab.status}`);
  return ab;
}

async function projectOfVisit(visitId: number): Promise<number> {
  return (await getVisitOr404(visitId)).projectId;
}

/**
 * Answer an ask-back with a photo from ANY visit of the same project.
 * - Photo from the ask-back's own visit: when that visit has no open ask-backs left, it re-runs (as before).
 * - Photo from a later visit: the request is closed; the new photo is assessed by the later visit's run.
 *   The earlier visit cannot use it, so if it was waiting only on requests, it moves on to review ("assessed").
 */
export async function fulfilAskBack(askBackId: number, photoId: number): Promise<AskBackResolution> {
  const ab = await getOpenAskBack(askBackId);
  const [photo] = await db.select().from(schema.photos).where(eq(schema.photos.id, photoId));
  if (!photo || (await projectOfVisit(photo.visitId)) !== (await projectOfVisit(ab.visitId))) {
    throw new HttpError(400, "Photo not in this project");
  }

  await db.transaction(async (tx) => {
    await tx.update(schema.photos).set({ askBackId: ab.id }).where(eq(schema.photos.id, photo.id));
    await tx.update(schema.askBacks).set({ status: "fulfilled" }).where(eq(schema.askBacks.id, ab.id));
  });

  if (photo.visitId === ab.visitId) return { status: "fulfilled", resumed: await resumeIfReady(ab.visitId), closedEarlierVisit: false };
  return { status: "fulfilled", resumed: false, closedEarlierVisit: await closeIfWaitingOnlyOnRequests(ab.visitId) };
}

export async function skipAskBack(askBackId: number): Promise<AskBackResolution> {
  const ab = await getOpenAskBack(askBackId);
  await db.update(schema.askBacks).set({ status: "skipped" }).where(eq(schema.askBacks.id, ab.id));
  return { status: "skipped", resumed: await resumeIfReady(ab.visitId), closedEarlierVisit: false };
}

/** Ask-backs may be answered by photos from any visit of the project; refuse ids from elsewhere or closed ones. */
export async function assertAskBackOpenInProject(askBackId: number, visitId: number): Promise<void> {
  const [ab] = await db.select().from(schema.askBacks).where(eq(schema.askBacks.id, askBackId));
  if (!ab || (await projectOfVisit(ab.visitId)) !== (await projectOfVisit(visitId))) throw new HttpError(400, "Ask-back not in this project");
  if (ab.status !== "open") throw new HttpError(409, `Ask-back is already ${ab.status}`);
}

/** When the last open ask-back of a visit is resolved, the agent resumes with a new run. */
async function resumeIfReady(visitId: number): Promise<boolean> {
  const visit = await getVisitOr404(visitId);
  if (visit.status !== "needs_input" || (await countOpenAskBacks(visitId)) > 0) return false;
  // Daily demo budget used up: don't start a new run; leave the visit reviewable so it can be re-run tomorrow.
  if (await overDailyCap()) {
    await db.update(schema.visits).set({ status: "assessed" }).where(and(eq(schema.visits.id, visitId), eq(schema.visits.status, "needs_input")));
    return false;
  }
  await queueAgentRun(visitId);
  return true;
}

async function closeIfWaitingOnlyOnRequests(visitId: number): Promise<boolean> {
  const visit = await getVisitOr404(visitId);
  if (visit.status !== "needs_input" || (await countOpenAskBacks(visitId)) > 0) return false;
  await db.update(schema.visits).set({ status: "assessed" }).where(and(eq(schema.visits.id, visitId), eq(schema.visits.status, "needs_input")));
  return true;
}
