import { Router } from "express";
import { and, desc, eq, inArray, max, count } from "drizzle-orm";
import { CreateProjectBody, type Project, type ProjectDetail, type ProjectListItem } from "@sitesight/shared";
import { db, schema } from "../db/client.js";
import { intParam, notFound, parse } from "../lib/http.js";
import { toVisitSummary } from "../lib/queries.js";
import { itemAssessmentsByProject, overallPercent } from "../lib/item-progress.js";

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
  const ids = rows.map((p) => p.id);
  if (!ids.length) return void res.json([]);
  const [items, lastVisits, openAsks, assessments] = await Promise.all([
    db
      .select({ projectId: schema.boqItems.projectId, id: schema.boqItems.id, plannedQty: schema.boqItems.plannedQty })
      .from(schema.boqItems)
      .where(inArray(schema.boqItems.projectId, ids)),
    db
      .select({ projectId: schema.visits.projectId, last: max(schema.visits.visitDate) })
      .from(schema.visits)
      .where(inArray(schema.visits.projectId, ids))
      .groupBy(schema.visits.projectId),
    db
      .select({ projectId: schema.visits.projectId, n: count() })
      .from(schema.askBacks)
      .innerJoin(schema.visits, eq(schema.visits.id, schema.askBacks.visitId))
      .where(and(inArray(schema.visits.projectId, ids), eq(schema.askBacks.status, "open")))
      .groupBy(schema.visits.projectId),
    itemAssessmentsByProject(ids),
  ]);
  const list: ProjectListItem[] = rows.map((p) => ({
    ...toProject(p),
    ...overallPercent(
      items.filter((i) => i.projectId === p.id),
      assessments.get(p.id),
    ),
    lastVisitDate: lastVisits.find((v) => v.projectId === p.id)?.last ?? null,
    openAskBacks: Number(openAsks.find((a) => a.projectId === p.id)?.n ?? 0),
  }));
  res.json(list);
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

  // Latest engineer-confirmed percent per BOQ item, plus the newest assessment of any status.
  const byItem = (await itemAssessmentsByProject([id])).get(id) ?? new Map();
  const progress: Record<string, number> = {};
  const itemAssessments: ProjectDetail["itemAssessments"] = {};
  for (const [itemId, entry] of byItem) {
    if (entry.confirmed) progress[String(itemId)] = entry.confirmed.percentComplete;
    itemAssessments[String(itemId)] = entry;
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
      panelPlannedQty: b.panelPlannedQty,
      stages: b.stages,
      sequenceNo: b.sequenceNo,
      drawingSource: b.drawingSource,
    })),
    visits: visits.map(toVisitSummary),
    progress,
    itemAssessments,
  };
  res.json(detail);
});
