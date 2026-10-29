/** UI data gaps: GET /projects card fields, per-item assessment summaries, and undoing an acceptance. */
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PatchAssessmentBody } from "@sitesight/shared";

vi.mock("../src/db/client.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("../src/db/schema.js");
  return { db: drizzle(new PGlite(), { schema }), schema, sql: { end: async () => {} } };
});

import express from "express";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { db as mockedDb, schema } from "../src/db/client.js";
import { projectsRouter } from "../src/routes/projects.js";
import { assessmentsRouter } from "../src/routes/assessments.js";
import { errorHandler } from "../src/lib/http.js";

const db = mockedDb as unknown as PgliteDatabase<typeof schema>;
let base = "";
let close = () => {};
type Key = "project" | "empty" | "zone" | "col" | "slb" | "ftg" | "v1" | "v2" | "slbOld" | "colNew" | "slbNew" | "ftgNew";
const ids = {} as Record<Key, number>;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../src/db/migrations", import.meta.url)) });
  const [p] = await db.insert(schema.projects).values({ name: "Main" }).returning();
  const [empty] = await db.insert(schema.projects).values({ name: "Empty" }).returning();
  ids.project = p!.id;
  ids.empty = empty!.id;
  const [zone] = await db.insert(schema.zones).values({ projectId: p!.id, name: "GF" }).returning();
  ids.zone = zone!.id;
  const item = async (code: string, plannedQty: number, extra: object = {}) =>
    (await db.insert(schema.boqItems).values({ projectId: p!.id, code, description: code, unit: "nos", plannedQty, measureMode: "visual_only", ...extra }).returning())[0]!.id;
  ids.col = await item("COL", 10);
  ids.slb = await item("SLB", 30, { stages: [{ name: "shuttering", weight: 0.25 }, { name: "reinforcement", weight: 0.35 }, { name: "concreting", weight: 0.4 }] });
  ids.ftg = await item("FTG", 60);
  const visit = async (visitDate: string, status: "assessed" | "reviewed") =>
    (await db.insert(schema.visits).values({ projectId: p!.id, visitDate, status }).returning())[0]!.id;
  ids.v1 = await visit("2026-10-20", "reviewed");
  ids.v2 = await visit("2026-10-28", "assessed");
  const assess = async (visitId: number, boqItemId: number, percentComplete: number, extra: object = {}) =>
    (await db.insert(schema.assessments).values({ visitId, boqItemId, percentComplete, confidence: 0.8, rationale: "r", ...extra }).returning())[0]!.id;
  // v1 (older): COL accepted 50; SLB accepted 25 (shuttering).
  await assess(ids.v1, ids.col, 50, { status: "accepted" });
  ids.slbOld = await assess(ids.v1, ids.slb, 25, { status: "accepted", stageReached: "shuttering" });
  // v2 (newer): COL accepted 100; SLB proposed 60 (reinforcement); FTG accepted 100 but inferred.
  ids.colNew = await assess(ids.v2, ids.col, 100, { status: "accepted", reviewedAt: new Date() });
  ids.slbNew = await assess(ids.v2, ids.slb, 60, { stageReached: "reinforcement" });
  ids.ftgNew = await assess(ids.v2, ids.ftg, 100, { status: "accepted", basis: "inferred", reviewedAt: new Date() });
  await db.insert(schema.askBacks).values([
    { visitId: ids.v2, zoneId: zone!.id, instruction: "a", reason: "r" },
    { visitId: ids.v1, zoneId: zone!.id, instruction: "b", reason: "r" },
    { visitId: ids.v1, zoneId: zone!.id, instruction: "c", reason: "r", status: "fulfilled" },
  ]);

  const server = express().use(express.json()).use(projectsRouter).use(assessmentsRouter).use(errorHandler).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

describe("GET /projects", () => {
  it("adds overall percent, inferred count, last visit date and open photo requests", async () => {
    const { body } = await call("GET", "/projects");
    const main = body.find((p: { id: number }) => p.id === ids.project);
    // Each item counts equally: (100 + 25 + 100) / 3. Planned quantities (10, 30, 60) don't weight it; SLB's newer
    // 60% is only proposed, so its confirmed 25% counts.
    expect(main).toMatchObject({ name: "Main", overallPercent: 75, inferredItems: 1, lastVisitDate: "2026-10-28", openAskBacks: 2 });
    expect(body.find((p: { id: number }) => p.id === ids.empty)).toMatchObject({ overallPercent: null, inferredItems: 0, lastVisitDate: null, openAskBacks: 0 });
  });
});

describe("GET /projects/:id itemAssessments", () => {
  it("returns the stored stage, basis and status of the confirmed and the latest assessment", async () => {
    const { body } = await call("GET", `/projects/${ids.project}`);
    expect(body.progress).toEqual({ [ids.col]: 100, [ids.slb]: 25, [ids.ftg]: 100 });
    expect(body.itemAssessments[ids.slb]).toEqual({
      confirmed: { assessmentId: ids.slbOld, visitId: ids.v1, visitDate: "2026-10-20", percentComplete: 25, stageReached: "shuttering", basis: "observed", status: "accepted" },
      latest: { assessmentId: ids.slbNew, visitId: ids.v2, visitDate: "2026-10-28", percentComplete: 60, stageReached: "reinforcement", basis: "observed", status: "proposed" },
    });
    expect(body.itemAssessments[ids.ftg].confirmed).toMatchObject({ basis: "inferred", status: "accepted" });
  });
});

describe("PATCH /assessments/:id undo", () => {
  it("only accepts status 'proposed'", () => {
    expect(PatchAssessmentBody.safeParse({ status: "proposed" }).success).toBe(true);
    expect(PatchAssessmentBody.safeParse({ status: "accepted" }).success).toBe(false);
    expect(PatchAssessmentBody.safeParse({ action: "accept" }).success).toBe(true);
  });

  it("reverts an acceptance and moves a reviewed visit back to assessed", async () => {
    // Make v2 fully reviewed first.
    await call("PATCH", `/assessments/${ids.slbNew}`, { action: "accept" });
    const [v] = await db.select().from(schema.visits).where(eq(schema.visits.id, ids.v2));
    expect(v!.status).toBe("reviewed");

    const { status, body } = await call("PATCH", `/assessments/${ids.slbNew}`, { status: "proposed" });
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "proposed", reviewedAt: null });
    const [after] = await db.select().from(schema.visits).where(eq(schema.visits.id, ids.v2));
    expect(after!.status).toBe("assessed");
  });

  it("refuses once a report was generated after the acceptance", async () => {
    const [r] = await db.insert(schema.reports).values({ visitId: ids.v2, storageKey: "r.pdf" }).returning();
    const { status, body } = await call("PATCH", `/assessments/${ids.colNew}`, { status: "proposed" });
    expect(status).toBe(409);
    expect(body.error).toMatch(new RegExp(`Can't undo: report #${r!.id} .* already includes it`));
  });

  it("allows undo when the report predates the acceptance", async () => {
    // Accept FTG again now (after the report above), then undo: the report doesn't include this acceptance.
    await call("PATCH", `/assessments/${ids.ftgNew}`, { action: "accept" });
    const { status, body } = await call("PATCH", `/assessments/${ids.ftgNew}`, { status: "proposed" });
    expect(status).toBe(200);
    expect(body.status).toBe("proposed");
  });

  it("treats an acceptance with no recorded time as covered by any report", async () => {
    const legacy = (await db.insert(schema.assessments).values({ visitId: ids.v2, boqItemId: ids.ftg, percentComplete: 1, confidence: 1, rationale: "", status: "accepted" }).onConflictDoUpdate({
      target: [schema.assessments.visitId, schema.assessments.boqItemId],
      set: { status: "accepted", reviewedAt: null },
    }).returning())[0]!;
    const { status } = await call("PATCH", `/assessments/${legacy.id}`, { status: "proposed" });
    expect(status).toBe(409);
  });
});
