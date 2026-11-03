/** Live trace readability: steps → cards (titles, tones, overlays) and the SSE "cost" event. */
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildTraceCards, type TraceStepLike } from "@sitesight/shared";

vi.mock("../src/db/client.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("../src/db/schema.js");
  return { db: drizzle(new PGlite(), { schema }), schema, sql: { end: async () => {} } };
});

import express from "express";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { db as mockedDb, schema } from "../src/db/client.js";
import { traceRouter } from "../src/routes/trace.js";
import { errorHandler } from "../src/lib/http.js";

let n = 0;
const call = (name: string, payload: unknown): TraceStepLike => ({ id: ++n, kind: "tool_call", name, payload });
const result = (name: string, payload: unknown): TraceStepLike => ({ id: ++n, kind: "tool_result", name, payload });
const itemCode = (id: number) => ({ 7: "SLB-GF", 8: "BWK-GF" })[id];

describe("buildTraceCards", () => {
  it("renders the demo titles with the right tones and overlays", () => {
    const steps: TraceStepLike[] = [
      call("segment_photo", { photo_id: 1, targets: ["column", "brickwork"] }),
      result("segment_photo", {
        photo_id: 1,
        targets: [
          { target: "column", instances: [{ segment_id: 4 }, { segment_id: 5 }] },
          { target: "brickwork", instances: [{ segment_id: 6 }] },
        ],
      }),
      { id: ++n, kind: "rejection", name: null, payload: { segment_id: 5, reason: "bamboo scaffolding pole", target: "column", photo_id: 1 } },
      call("verify_segments", { photo_id: 1 }),
      result("verify_segments", { photo_id: 1, kept: [4, 6], rejected: [5] }),
      call("measure", { photo_id: 1, target_segment_ids: [6] }),
      result("measure", { mode: "panel", photo_id: 1, fraction: 0.64, measurement_id: 12 }),
      call("record_assessment", { boq_item_id: 7, stage_reached: "reinforcement", rationale: "bars visible" }),
      result("record_assessment", { percent_complete: 60, stage_reached: "reinforcement", basis: "observed" }),
      call("record_assessment", { boq_item_id: 8, basis: "inferred" }),
      result("record_assessment", { percent_complete: 50 }),
      call("request_photo", { instruction: "Close-up of the slab edge from the stair", reason: "edge hidden" }),
      result("request_photo", { ask_back_id: 3 }),
      call("measure", { photo_id: 1 }),
      result("measure", { error: "photo 1 has unverified segments" }),
      { id: ++n, kind: "error", name: "cost_limit", payload: { message: "over $1.50" } },
    ];
    const cards = buildTraceCards(steps, { itemCode });
    expect(cards.map((c) => [c.tone, c.title])).toEqual([
      ["neutral", "Segmenting photo 1 — columns, brickwork"],
      ["rejection", "Rejected #5: bamboo scaffolding pole"],
      ["neutral", "Verified photo 1: kept 2, rejected 1"],
      ["neutral", "Measured panel: 64% filled"],
      ["assessment", "SLB-GF → reinforcement stage (60%)"],
      ["assessment", "BWK-GF → 50% · inferred"],
      ["askback", "Requested photo: Close-up of the slab edge from the stair"],
      ["error", "measure failed"],
      ["error", "Stopped: cost limit reached"],
    ]);
    expect(cards[0]!.subtitle).toBe("found 2 columns, 1 brickwork");
    expect(cards[0]!.overlay).toEqual({ photoId: 1, segmentIds: [4, 5, 6] });
    expect(cards[2]!.overlay).toEqual({ photoId: 1, segmentIds: [4, 6] });
    expect(cards[3]!.overlay).toEqual({ photoId: 1, segmentIds: [6], panelIds: [12] });
    // Raw JSON stays available for the details toggle: call args folded into the result card.
    expect(cards[4]!.details).toEqual({
      args: { boq_item_id: 7, stage_reached: "reinforcement", rationale: "bars visible" },
      result: { percent_complete: 60, stage_reached: "reinforcement", basis: "observed" },
    });
    expect(cards.filter((c) => c.tone !== "neutral").every((c) => !c.overlay)).toBe(true);
  });

  it("pairs repeated calls of the same tool with their results in order", () => {
    const cards = buildTraceCards([
      call("record_assessment", { boq_item_id: 7 }),
      call("record_assessment", { boq_item_id: 8 }),
      result("record_assessment", { percent_complete: 10 }),
      result("record_assessment", { percent_complete: 20 }),
    ]);
    expect(cards.map((c) => c.title)).toEqual(["item #7 → 10%", "item #8 → 20%"]);
  });
});

describe("GET /visits/:id/trace", () => {
  const db = mockedDb as unknown as PgliteDatabase<typeof schema>;
  let base = "";
  let close = () => {};
  let visitId = 0;

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../src/db/migrations", import.meta.url)) });
    const [project] = await db.insert(schema.projects).values({ name: "P" }).returning();
    const [visit] = await db.insert(schema.visits).values({ projectId: project!.id }).returning();
    visitId = visit!.id;
    const [run] = await db.insert(schema.agentRuns).values({ visitId, costUsd: 0.0123 }).returning();
    await db.insert(schema.agentRuns).values({ visitId, costUsd: 0.1 });
    await db.insert(schema.agentSteps).values({ runId: run!.id, idx: 0, kind: "model", name: null, payload: { text: "hi" } });
    const app = express().use(traceRouter).use(errorHandler);
    const server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());

  it("streams steps, status and the visit's running cost", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/visits/${visitId}/trace`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes("event: cost")) text += new TextDecoder().decode((await reader.read()).value);
    ctrl.abort();
    expect(text).toContain("event: step");
    expect(text).toContain('event: status\ndata: {"status":"draft"}');
    expect(text).toContain('event: cost\ndata: {"costUsd":0.1123}');
  });
});

describe("fast path cards", () => {
  it("summarises a record_assessments batch and names failed items", () => {
    let id = 0;
    const step = (kind: TraceStepLike["kind"], name: string | null, payload: unknown) => ({ id: ++id, kind, name, payload }) as TraceStepLike;
    const cards = buildTraceCards(
      [
        step("tool_call", "record_assessments", { items: [{ boq_item_id: 1 }, { boq_item_id: 2 }] }),
        step("tool_result", "record_assessments", {
          recorded: 1,
          failed: 1,
          results: [
            { index: 0, boq_item_id: 1, ok: true },
            { index: 1, boq_item_id: 2, ok: false, error: "percent_complete is required for B." },
          ],
        }),
        step("notice", "pre_segmented", { message: "Segmented 2 photo(s) for column before the first turn; 2 overlay(s) attached." }),
      ],
      { itemCode: (n) => (n === 2 ? "B" : "A") },
    );
    expect(cards[0]).toMatchObject({ tone: "error", title: "Recorded 1 assessment in one call, 1 failed", subtitle: "B: percent_complete is required for B." });
    expect(cards[1]).toMatchObject({ title: "Photos segmented before the first turn (fast path)" });
  });
});
