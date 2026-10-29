/** Deleting a project (e2e cleanup / db:purge-e2e): every dependent row, its jobs and its stored files. */
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { deleted } = vi.hoisted(() => ({ deleted: [] as string[] }));

vi.mock("../src/db/client.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("../src/db/schema.js");
  return { db: drizzle(new PGlite(), { schema }), schema, sql: { end: async () => {} } };
});
vi.mock("../src/services/storage.js", () => ({
  deleteObject: async (key: string) => void deleted.push(key),
}));

import { migrate } from "drizzle-orm/pglite/migrator";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { db as mockedDb, schema } from "../src/db/client.js";
import { deleteProject, findE2eProjects } from "../src/services/projects-admin.js";

const db = mockedDb as unknown as PgliteDatabase<typeof schema>;

async function fullProject(name: string) {
  const [p] = await db.insert(schema.projects).values({ name }).returning();
  const [z] = await db.insert(schema.zones).values({ projectId: p!.id, name: "GF" }).returning();
  const [item] = await db.insert(schema.boqItems).values({ projectId: p!.id, code: "A", description: "a", unit: "nos", plannedQty: 1, measureMode: "visual_only" }).returning();
  const [v] = await db.insert(schema.visits).values({ projectId: p!.id }).returning();
  const [ab] = await db.insert(schema.askBacks).values({ visitId: v!.id, zoneId: z!.id, boqItemId: item!.id, instruction: "photo", reason: "r" }).returning();
  const [ph] = await db
    .insert(schema.photos)
    .values({ visitId: v!.id, zoneId: z!.id, storageKey: `${name}/photo.jpg`, voiceNoteKey: `${name}/voice.webm`, width: 1, height: 1, askBackId: ab!.id })
    .returning();
  await db.insert(schema.segments).values({ photoId: ph!.id, concept: "column", instanceIdx: 0, maskKey: `${name}/mask.png`, bbox: [0, 0, 1, 1], areaPx: 1, score: 1 });
  const [a] = await db.insert(schema.assessments).values({ visitId: v!.id, boqItemId: item!.id, percentComplete: 10, confidence: 0.5, rationale: "r" }).returning();
  await db.insert(schema.assessmentEvidence).values({ assessmentId: a!.id, photoId: ph!.id });
  const [run] = await db.insert(schema.agentRuns).values({ visitId: v!.id }).returning();
  await db.insert(schema.agentSteps).values({ runId: run!.id, idx: 0, kind: "model", payload: {} });
  await db.insert(schema.panelMeasurements).values({
    visitId: v!.id, photoId: ph!.id, runId: run!.id, targetSegmentIds: [], panel: {}, panelAreaPx: 1, coveredAreaPx: 0, fraction: 0, clipped: false, warnings: [],
  });
  await db.insert(schema.reports).values({ visitId: v!.id, storageKey: `${name}/report.pdf` });
  await db.insert(schema.jobs).values({ kind: "agent_run", payload: { visitId: v!.id } });
  return { projectId: p!.id, visitId: v!.id };
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../src/db/migrations", import.meta.url)) });
});

describe("deleteProject", () => {
  it("removes the project with all dependent rows, its jobs and its stored files, and nothing else", async () => {
    const doomed = await fullProject("Demo Residence (e2e 20261029-0500)");
    const kept = await fullProject("Demo Residence");

    const result = await deleteProject(doomed.projectId, { deleteFiles: true });

    expect(result).toMatchObject({ projectId: doomed.projectId, visits: 1, storageKeys: 4, filesDeleted: 4 });
    expect(deleted.sort()).toEqual(
      ["photo.jpg", "voice.webm", "mask.png", "report.pdf"].map((f) => `Demo Residence (e2e 20261029-0500)/${f}`).sort(),
    );
    for (const table of [schema.projects, schema.zones, schema.boqItems, schema.visits]) {
      const rows = await db.select().from(table as typeof schema.projects);
      expect(rows.every((r) => !("projectId" in r) || (r as unknown as { projectId: number }).projectId !== doomed.projectId)).toBe(true);
    }
    expect(await db.select().from(schema.visits).where(eq(schema.visits.id, doomed.visitId))).toHaveLength(0);
    expect(await db.select().from(schema.agentSteps)).toHaveLength(1); // only the kept project's
    expect(await db.select().from(schema.panelMeasurements)).toHaveLength(1);
    expect((await db.select().from(schema.jobs)).map((j) => (j.payload as { visitId: number }).visitId)).toEqual([kept.visitId]);
    expect(await db.select().from(schema.projects).where(eq(schema.projects.id, kept.projectId))).toHaveLength(1);
  });

  it("leaves files alone unless asked, and returns null for unknown projects", async () => {
    deleted.length = 0;
    const p = await fullProject("Temp (e2e x)");
    expect(await deleteProject(p.projectId)).toMatchObject({ filesDeleted: 0, storageKeys: 4 });
    expect(deleted).toEqual([]);
    expect(await deleteProject(999_999)).toBeNull();
  });

  it("finds e2e projects by name only", async () => {
    await fullProject("Site X (e2e 1)");
    await fullProject("Real e2e project without the marker");
    const names = (await findE2eProjects()).map((p) => p.name);
    expect(names).toContain("Site X (e2e 1)");
    expect(names).not.toContain("Real e2e project without the marker");
    expect(names).not.toContain("Demo Residence");
  });
});
