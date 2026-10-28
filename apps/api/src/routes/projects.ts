import { Router } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { CreateProjectBody, type Project, type ProjectDetail } from "@sitesight/shared";
import { db, schema } from "../db/client.js";
import { intParam, notFound, parse } from "../lib/http.js";
import { toVisitSummary } from "../lib/queries.js";

export const projectsRouter = Router();

type ProjectRow = typeof schema.projects.$inferSelect;
const toProject = (p: ProjectRow): Project => ({
  id: p.id,
  name: p.name,
  locationLabel: p.locationLabel,
  createdAt: p.createdAt.toISOString(),
});

projectsRouter.get("/projects", async (_req, res) => {
  const rows = await db.select().from(schema.projects).orderBy(desc(schema.projects.createdAt));
  res.json(rows.map(toProject));
});

projectsRouter.post("/projects", async (req, res) => {
  const body = parse(CreateProjectBody, req.body);
  const [p] = await db.insert(schema.projects).values(body).returning();
  res.status(201).json(toProject(p!));
});

projectsRouter.get("/projects/:id", async (req, res) => {
  const id = intParam(req.params.id);
  const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, id));
  if (!p) notFound("Project");

  const zones = await db.select().from(schema.zones).where(eq(schema.zones.projectId, id)).orderBy(schema.zones.sortOrder);
  const items = await db.select().from(schema.boqItems).where(eq(schema.boqItems.projectId, id)).orderBy(schema.boqItems.id);
  const visits = await db
    .select()
    .from(schema.visits)
    .where(eq(schema.visits.projectId, id))
    .orderBy(desc(schema.visits.visitDate), desc(schema.visits.id));

  // Latest engineer-confirmed percent per BOQ item (visits are already newest-first).
  const progress: Record<string, number> = {};
  if (visits.length) {
    const confirmed = await db
      .select({ boqItemId: schema.assessments.boqItemId, pct: schema.assessments.percentComplete, visitId: schema.assessments.visitId })
      .from(schema.assessments)
      .where(
        and(
          inArray(
            schema.assessments.visitId,
            visits.map((v) => v.id),
          ),
          inArray(schema.assessments.status, ["accepted", "edited"]),
        ),
      );
    const order = new Map(visits.map((v, i) => [v.id, i]));
    confirmed.sort((a, b) => order.get(a.visitId)! - order.get(b.visitId)!);
    for (const c of confirmed) progress[String(c.boqItemId)] ??= c.pct;
  }

  const detail: ProjectDetail = {
    ...toProject(p),
    zones: zones.map((z) => ({ id: z.id, projectId: z.projectId, name: z.name, sortOrder: z.sortOrder })),
    boqItems: items.map((b) => ({
      id: b.id,
      projectId: b.projectId,
      zoneId: b.zoneId,
      code: b.code,
      description: b.description,
      unit: b.unit,
      plannedQty: b.plannedQty,
      measureMode: b.measureMode,
      segmentTargets: b.segmentTargets,
      sequenceNo: b.sequenceNo,
    })),
    visits: visits.map(toVisitSummary),
    progress,
  };
  res.json(detail);
});
