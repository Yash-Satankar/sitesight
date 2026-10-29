import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { PresignBody, RegisterPhotoBody, type PresignResponse } from "@sitesight/shared";
import { db, schema } from "../db/client.js";
import { HttpError, intParam, parse } from "../lib/http.js";
import { getVisitOr404 } from "../lib/queries.js";
import { loadNormalizedPhoto } from "../services/images.js";
import { enqueue } from "../services/jobs.js";
import { assertAskBackOpenInProject } from "../services/ask-backs.js";
import { newKey, presignPut } from "../services/storage.js";

export const photosRouter = Router();

/** Browser uploads straight to R2 with this URL, then registers the key below. */
photosRouter.post("/visits/:id/photos/presign", async (req, res) => {
  const visitId = intParam(req.params.id);
  await getVisitOr404(visitId);
  const { contentType, kind } = parse(PresignBody, req.body);
  const storageKey = newKey(`visits/${visitId}/${kind === "voice" ? "voice" : "photos"}`, contentType);
  const body: PresignResponse = { uploadUrl: await presignPut(storageKey, contentType), storageKey };
  res.json(body);
});

photosRouter.post("/visits/:id/photos", async (req, res) => {
  const visitId = intParam(req.params.id);
  const visit = await getVisitOr404(visitId);
  const body = parse(RegisterPhotoBody, req.body);

  if (!body.storageKey.startsWith(`visits/${visitId}/photos/`)) throw new HttpError(400, "storageKey does not belong to this visit");
  if (body.voiceNoteKey && !body.voiceNoteKey.startsWith(`visits/${visitId}/voice/`)) {
    throw new HttpError(400, "voiceNoteKey does not belong to this visit");
  }
  const [zone] = await db
    .select()
    .from(schema.zones)
    .where(and(eq(schema.zones.id, body.zoneId), eq(schema.zones.projectId, visit.projectId)));
  if (!zone) throw new HttpError(400, "Zone not in this project");
  // A photo may answer an open ask-back from any visit of this project (e.g. last visit's request).
  if (body.askBackId) await assertAskBackOpenInProject(body.askBackId, visitId);

  // Dimensions of the normalised image; all masks use this coordinate space.
  const img = await loadNormalizedPhoto(body.storageKey);
  const [photo] = await db
    .insert(schema.photos)
    .values({
      visitId,
      zoneId: zone.id,
      storageKey: body.storageKey,
      width: img.width,
      height: img.height,
      voiceNoteKey: body.voiceNoteKey ?? null,
      askBackId: body.askBackId ?? null,
    })
    .returning();

  if (photo!.voiceNoteKey) await enqueue("transcribe", { photoId: photo!.id });
  res.status(201).json(photo);
});
