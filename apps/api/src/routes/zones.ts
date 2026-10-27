import { Router } from "express";
import { eq } from "drizzle-orm";
import { CreateZoneBody } from "@sitesight/shared";
import { db, schema } from "../db/client.js";
import { intParam, notFound, parse } from "../lib/http.js";

export const zonesRouter = Router();

zonesRouter.post("/projects/:id/zones", async (req, res) => {
  const projectId = intParam(req.params.id);
  const body = parse(CreateZoneBody, req.body);
  const [p] = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId));
  if (!p) notFound("Project");
  const [z] = await db.insert(schema.zones).values({ projectId, ...body }).returning();
  res.status(201).json(z);
});
