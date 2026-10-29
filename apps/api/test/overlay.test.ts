/** GET /photos/:id/overlay: kept masks drawn, rejected hidden, measured panels outlined; assessments list their panels. */
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { store } = vi.hoisted(() => ({ store: new Map<string, Buffer>() }));

vi.mock("../src/db/client.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("../src/db/schema.js");
  return { db: drizzle(new PGlite(), { schema }), schema, sql: { end: async () => {} } };
});
vi.mock("../src/services/storage.js", () => ({
  getObject: async (key: string) => {
    const v = store.get(key);
    if (!v) throw new Error(`no object ${key}`);
    return v;
  },
  putObject: async (key: string, body: Buffer) => void store.set(key, body),
  presignGet: async (key: string) => `/storage/${key}`,
  newKey: (prefix: string) => `${prefix}/${Math.random()}`,
}));

import express from "express";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { db as mockedDb, schema } from "../src/db/client.js";
import { overlayRouter } from "../src/routes/overlay.js";
import { errorHandler } from "../src/lib/http.js";
import { rasterToFrameMask } from "../src/meta/masks.js";
import { loadAssessments } from "../src/lib/queries.js";

const db = mockedDb as unknown as PgliteDatabase<typeof schema>;
const W = 120;
const H = 100;
let base = "";
let close = () => {};
let ids: { photo: number; other: number; kept: number; rejected: number; pending: number; otherSeg: number; panel: number; otherPanel: number; visit: number; item: number };

async function segment(photoId: number, x: number, y: number, verified: boolean | null) {
  const mask = (await rasterToFrameMask(new Uint8Array(30 * 30).fill(1), 30, 30, x, y, W, H)).png;
  const key = `m/${photoId}/${x}-${y}`;
  store.set(key, mask);
  const [s] = await db
    .insert(schema.segments)
    .values({ photoId, concept: "column", instanceIdx: 0, maskKey: key, bbox: [x, y, 30, 30], areaPx: 900, score: 0.9, verified })
    .returning();
  return s!.id;
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../src/db/migrations", import.meta.url)) });
  store.set("p.jpg", await sharp({ create: { width: W, height: H, channels: 3, background: "#808080" } }).jpeg({ quality: 100 }).toBuffer());
  const [project] = await db.insert(schema.projects).values({ name: "P" }).returning();
  const [zone] = await db.insert(schema.zones).values({ projectId: project!.id, name: "GF" }).returning();
  const [visit] = await db.insert(schema.visits).values({ projectId: project!.id }).returning();
  const photo = async () => (await db.insert(schema.photos).values({ visitId: visit!.id, zoneId: zone!.id, storageKey: "p.jpg", width: W, height: H }).returning())[0]!.id;
  const p = await photo();
  const other = await photo();
  const panel = async (photoId: number) =>
    (
      await db
        .insert(schema.panelMeasurements)
        .values({
          visitId: visit!.id, photoId, targetSegmentIds: [], panel: { polygon: [[50, 50], [110, 50], [110, 95], [50, 95]] },
          panelAreaPx: 1, coveredAreaPx: 1, fraction: 0.64, clipped: false, warnings: [],
        })
        .returning()
    )[0]!.id;
  const [item] = await db.insert(schema.boqItems).values({ projectId: project!.id, code: "B", description: "b", unit: "m2", plannedQty: 10, measureMode: "area", segmentTargets: ["brickwork"] }).returning();
  ids = {
    photo: p,
    other,
    kept: await segment(p, 10, 10, true),
    rejected: await segment(p, 60, 10, false),
    pending: await segment(p, 10, 60, null),
    otherSeg: await segment(other, 10, 10, true),
    panel: await panel(p),
    otherPanel: await panel(other),
    visit: visit!.id,
    item: item!.id,
  };

  const app = express();
  app.use(overlayRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

async function overlay(query: string) {
  const res = await fetch(`${base}/photos/${ids.photo}/overlay?max=1600${query}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/^image\/png/);
  const png = Buffer.from(await res.arrayBuffer());
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  expect([info.width, info.height]).toEqual([W, H]);
  return (x: number, y: number) => [...data.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)];
}
const tinted = (px: number[]) => px.some((c) => Math.abs(c - 128) > 15);

describe("GET /photos/:id/overlay", () => {
  it("draws only kept segments by default", async () => {
    const at = await overlay("");
    expect(tinted(at(25, 25))).toBe(true); // kept
    expect(tinted(at(75, 25))).toBe(false); // rejected
    expect(tinted(at(25, 75))).toBe(false); // unverified, not asked for
  });

  it("draws the requested segments but never a rejected one", async () => {
    const at = await overlay(`&segments=${ids.kept},${ids.rejected},${ids.pending}`);
    expect(tinted(at(25, 25))).toBe(true);
    expect(tinted(at(25, 75))).toBe(true);
    expect(tinted(at(75, 25))).toBe(false);
  });

  it("outlines a measured panel", async () => {
    const at = await overlay(`&segments=${ids.kept}&panel=${ids.panel}`);
    const [r, g, b] = at(80, 50); // on the panel's top edge
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(170);
    expect(b).toBeLessThan(90);
  });

  it("scales down to ?max", async () => {
    const res = await fetch(`${base}/photos/${ids.photo}/overlay?max=160`);
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect(meta.width).toBe(W); // never enlarged
  });

  it("refuses ids from another photo, unknown photos and malformed lists", async () => {
    expect((await fetch(`${base}/photos/${ids.photo}/overlay?segments=${ids.otherSeg}`)).status).toBe(400);
    expect((await fetch(`${base}/photos/${ids.photo}/overlay?panel=${ids.otherPanel}`)).status).toBe(400);
    expect((await fetch(`${base}/photos/999999/overlay`)).status).toBe(404);
    expect((await fetch(`${base}/photos/${ids.photo}/overlay?segments=1,abc`)).status).toBe(400);
  });
});

describe("assessments carry their panel measurements", () => {
  it("loadAssessments returns panel id, photo and fraction", async () => {
    await db.insert(schema.assessments).values({
      visitId: ids.visit, boqItemId: ids.item, percentComplete: 64, confidence: 0.7, rationale: "r", panelMeasurementIds: [ids.panel],
    });
    const [a] = await loadAssessments(ids.visit);
    expect(a!.panels).toEqual([{ id: ids.panel, photoId: ids.photo, fraction: 0.64 }]);
  });
});
