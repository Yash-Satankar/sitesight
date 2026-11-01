/**
 * Spend ledger: every model cost lands in an append-only table that survives project deletion; the daily cap reads
 * it; spreadsheet BOQ parses are recorded; the migration backfills existing run/import costs.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { fake } = vi.hoisted(() => ({ fake: { reply: "{}" } }));
vi.mock("../src/meta/client.js", () => ({
  metaClient: () => ({
    responses: { create: async () => ({ output_text: fake.reply, output: [], usage: { input_tokens: 200, output_tokens: 200 } }) }, // $0.004
  }),
}));
vi.mock("../src/db/client.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("../src/db/schema.js");
  return { db: drizzle(new PGlite(), { schema }), schema, sql: { end: async () => {} } };
});

import express from "express";
import ExcelJS from "exceljs";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schemaModule from "../src/db/schema.js";
import { db as mockedDb, schema } from "../src/db/client.js";
import { addRunCost, createBudgetGate, recordSpend } from "../src/meta/cost.js";
import { dailySpend, startOfUtcDay } from "../src/lib/spend.js";
import { deleteProject } from "../src/services/projects-admin.js";
import { boqRouter } from "../src/routes/boq.js";
import { errorHandler } from "../src/lib/http.js";

const db = mockedDb as unknown as PgliteDatabase<typeof schema>;
const migrationsFolder = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
const ids = { project: 0, visit: 0, run: 0 };
let base = "";
let close = () => {};

const ledger = () => db.select().from(schema.spendLedger).orderBy(schema.spendLedger.id);

beforeAll(async () => {
  await migrate(db, { migrationsFolder });
  const [p] = await db.insert(schema.projects).values({ name: "Ledger" }).returning();
  const [v] = await db.insert(schema.visits).values({ projectId: p!.id }).returning();
  const [r] = await db.insert(schema.agentRuns).values({ visitId: v!.id }).returning();
  Object.assign(ids, { project: p!.id, visit: v!.id, run: r!.id });
  const server = express().use(boqRouter).use(errorHandler).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

describe("spend ledger", () => {
  it("records each agent-run model call and SAM request with project and visit", async () => {
    await addRunCost(ids.run, { costUsd: 0.004, inputTokens: 200, outputTokens: 200 });
    const gate = createBudgetGate(ids.run, 0.0035); // SAM requests
    await gate.reserve();
    await gate.settle();
    expect((await ledger()).map((r) => [r.kind, r.projectId, r.visitId, r.costUsd])).toEqual([
      ["agent_run", ids.project, ids.visit, 0.004],
      ["agent_run", ids.project, ids.visit, 0.0035],
    ]);
    // agent_runs still carries the per-visit total (the per-visit cap reads it)
    const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, ids.run));
    expect(run!.costUsd).toBeCloseTo(0.0075);
  });

  it("skips zero costs", async () => {
    const before = (await ledger()).length;
    await recordSpend({ kind: "boq_parse", costUsd: 0, projectId: ids.project });
    expect((await ledger()).length).toBe(before);
  });

  it("records spreadsheet BOQ parses (previously unrecorded) and they count toward today's spend", async () => {
    fake.reply = JSON.stringify({
      items: [{ code: "1.1", description: "RCC columns", unit: "nos", plannedQty: 12, measureMode: "count", segmentTargets: ["column"], sequenceNo: 1 }],
      warnings: [],
    });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("BOQ");
    ws.addRow(["Code", "Description", "Unit", "Qty"]);
    ws.addRow(["1.1", "RCC columns", "nos", 12]);
    const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(xlsx)]), "boq.xlsx");
    const before = (await dailySpend()).spentUsd;
    const res = await fetch(`${base}/projects/${ids.project}/boq`, { method: "POST", body: form });
    expect(res.status).toBe(200);
    expect((await res.json()).items).toHaveLength(1);
    const rows = (await ledger()).filter((r) => r.kind === "boq_parse");
    expect(rows.map((r) => [r.projectId, r.visitId, r.costUsd])).toEqual([[ids.project, null, 0.004]]);
    expect((await dailySpend()).spentUsd).toBeCloseTo(before + 0.004);
  });

  it("keeps the spend when the project is deleted, so the daily cap can't be reset by deleting projects", async () => {
    const before = await dailySpend();
    expect(before.spentUsd).toBeGreaterThan(0);
    await deleteProject(ids.project, { deleteFiles: false });
    expect(await db.select().from(schema.projects).where(eq(schema.projects.id, ids.project))).toEqual([]);
    expect((await dailySpend()).spentUsd).toBe(before.spentUsd);
    expect((await ledger()).every((r) => r.projectId === ids.project)).toBe(true); // rows keep the old id
  });

  it("counts only today's rows (UTC)", async () => {
    const before = (await dailySpend()).spentUsd;
    await db.insert(schema.spendLedger).values({ kind: "agent_run", costUsd: 3, at: new Date(startOfUtcDay().getTime() - 1000) });
    expect((await dailySpend()).spentUsd).toBe(before);
  });
});

describe("migration 0009 backfills existing costs", () => {
  it("copies agent-run and drawing-import costs into the ledger", async () => {
    // Migrations up to 0008 only (before the ledger existed), then data, then the rest.
    const dir = mkdtempSync(join(tmpdir(), "sitesight-migrations-"));
    cpSync(migrationsFolder, dir, { recursive: true });
    const journalPath = join(dir, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    const ledgerEntry = journal.entries.findIndex((e: { tag: string }) => e.tag.startsWith("0009_"));
    expect(ledgerEntry).toBeGreaterThan(0);
    writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, ledgerEntry) }));

    const old = drizzle(new PGlite(), { schema: schemaModule });
    await migrate(old, { migrationsFolder: dir });
    const [p] = await old.insert(schemaModule.projects).values({ name: "Old" }).returning();
    const [v] = await old.insert(schemaModule.visits).values({ projectId: p!.id }).returning();
    await old.insert(schemaModule.agentRuns).values({ visitId: v!.id, costUsd: 0.1294, startedAt: new Date("2026-11-01T15:38:02Z") });
    await old.insert(schemaModule.agentRuns).values({ visitId: v!.id, costUsd: 0 }); // nothing spent: no row
    await old.insert(schemaModule.drawingImports).values({ projectId: p!.id, fileName: "demo-residence.pdf", costUsd: 0.25, createdAt: new Date("2026-10-30T10:00:00Z") });

    await migrate(old, { migrationsFolder }); // applies 0009
    const rows = await old.select().from(schemaModule.spendLedger).orderBy(schemaModule.spendLedger.id);
    expect(rows.map((r) => [r.kind, r.projectId, r.visitId, r.costUsd, r.at.toISOString()])).toEqual([
      ["agent_run", p!.id, v!.id, 0.1294, "2026-11-01T15:38:02.000Z"],
      ["drawing_import", p!.id, null, 0.25, "2026-10-30T10:00:00.000Z"],
    ]);
  });
});
