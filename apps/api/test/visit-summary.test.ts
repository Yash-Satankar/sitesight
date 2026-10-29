/** GET /visits/:id summary: assessed / inferred / awaiting-photo counts and progress since the previous assessed visit. */
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { progressRows } from "@sitesight/shared";

vi.mock("../src/db/client.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("../src/db/schema.js");
  return { db: drizzle(new PGlite(), { schema }), schema, sql: { end: async () => {} } };
});
vi.mock("../src/services/storage.js", () => ({ presignGet: async (key: string) => `/storage/${key}` }));

import { migrate } from "drizzle-orm/pglite/migrator";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { db as mockedDb, schema } from "../src/db/client.js";
import { loadVisitDetail } from "../src/lib/queries.js";

const db = mockedDb as unknown as PgliteDatabase<typeof schema>;
const v: Record<string, number> = {};
const it_: Record<string, number> = {};

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../src/db/migrations", import.meta.url)) });
  const [project] = await db.insert(schema.projects).values({ name: "P" }).returning();
  const [zone] = await db.insert(schema.zones).values({ projectId: project!.id, name: "GF" }).returning();
  for (const code of ["COL", "SLB", "BWK", "PLS", "DOR"]) {
    const [row] = await db
      .insert(schema.boqItems)
      .values({ projectId: project!.id, zoneId: zone!.id, code, description: `${code} work`, unit: "m3", plannedQty: 10, measureMode: "visual_only" })
      .returning();
    it_[code] = row!.id;
  }
  const visit = async (visitDate: string) => (await db.insert(schema.visits).values({ projectId: project!.id, visitDate }).returning())[0]!.id;
  v.first = await visit("2026-10-01");
  v.empty = await visit("2026-10-08"); // no assessments: skipped as "previous"
  v.now = await visit("2026-10-15");
  const assess = (visitId: number, code: string, percentComplete: number, extra: object = {}) =>
    db.insert(schema.assessments).values({ visitId, boqItemId: it_[code]!, percentComplete, confidence: 0.8, rationale: "r", ...extra });
  await assess(v.first!, "COL", 40, { status: "accepted" });
  await assess(v.first!, "SLB", 70, { status: "accepted" });
  await assess(v.now!, "COL", 80);
  await assess(v.now!, "SLB", 60);
  await assess(v.now!, "BWK", 30, { basis: "inferred" });
  // PLS waits on a request from the earlier visit; DOR has nothing.
  await db.insert(schema.askBacks).values({ visitId: v.first!, zoneId: zone!.id, boqItemId: it_.PLS!, instruction: "photo of plaster", reason: "hidden" });
});

describe("visit summary", () => {
  it("counts items and compares with the previous assessed visit", async () => {
    const { summary } = await loadVisitDetail(v.now!);
    expect(summary).toMatchObject({ totalItems: 5, assessed: 2, inferred: 1, awaitingPhoto: 1, notAssessed: 1 });
    expect(summary.previousVisit).toEqual({ id: v.first, visitDate: "2026-10-01" });
    expect(summary.sinceLastVisit.map((r) => [r.code, r.previous, r.now, r.change, r.delta])).toEqual([
      ["COL", "40%", "80%", "+40 pts", 40],
      ["SLB", "70%", "60%", "-10 pts, went backwards (deviation)", -10],
      ["BWK", "not assessed", "30%", "new", null],
      ["PLS", "not assessed", expect.stringContaining("awaiting photo"), "—", null],
      ["DOR", "not assessed", "not assessed", "—", null],
    ]);
  });

  it("has no comparison for the first visit", async () => {
    const { summary } = await loadVisitDetail(v.first!);
    expect(summary.previousVisit).toBeNull();
    expect(summary.sinceLastVisit).toEqual([]);
    expect(summary).toMatchObject({ assessed: 2, awaitingPhoto: 1, notAssessed: 2 });
  });
});

describe("progressRows (shared with the dry run)", () => {
  it("marks small moves as no change", () => {
    const row = (pct: number) => [{ code: "A", description: "a", status: "assessed", assessment: { percentComplete: pct, stageReached: null } }];
    expect(progressRows(row(50), row(50.3))[0]).toMatchObject({ change: "no change", delta: 0.3 });
  });
});
