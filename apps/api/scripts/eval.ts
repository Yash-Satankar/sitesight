/**
 * Evaluation harness: run labelled cases through the real agent / drawing import and score them.
 *
 *   pnpm eval                       # every case once
 *   pnpm eval --runs 3              # consistency: same case, three runs
 *   pnpm eval --only demo-residence-drawings # one case (comma-separate several)
 *   pnpm eval --max-cost 5          # hard cap on Meta spend for the whole eval (default $10)
 *
 * Photo cases use the dry-run machinery (in-memory Postgres, local files); drawing cases use the DB-free drawing
 * pipeline. Writes samples/out/eval/<time>/report.md and report.json and prints a summary table for the README.
 * Calls Meta for real: needs META_API_KEY / META_BASE_URL and prices in .env.
 */
import { copyFile, mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  EVAL_USAGE,
  EvalBudget,
  headlineNote,
  parseCases,
  reportMarkdown,
  scoreDrawingRun,
  scorePhotoRun,
  summarize,
  summaryTable,
  consistency,
  type DrawingCase,
  type EvalCase,
  type PhotoCase,
  type RunRecord,
} from "./eval-lib.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    runs: { type: "string", default: "1" },
    only: { type: "string" },
    "max-cost": { type: "string", default: "10" },
    cases: { type: "string", default: "samples/eval/cases.json" },
    name: { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (args.help) {
  console.log(EVAL_USAGE);
  process.exit(0);
}
const runs = Number(args.runs);
const maxCost = Number(args["max-cost"]);
if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error("--runs must be 1–10");
if (!(maxCost > 0)) throw new Error("--max-cost must be a positive number of USD");

const fromRoot = (p: string) => resolve(repoRoot, p);
const file = parseCases(await readFile(fromRoot(args.cases!), "utf8"));
const only = args.only?.split(",").map((s) => s.trim()).filter(Boolean);
const cases = file.cases.filter((c) => !only || only.includes(c.id));
if (only) {
  const unknown = only.filter((id) => !file.cases.some((c) => c.id === id));
  if (unknown.length) throw new Error(`Unknown case id(s): ${unknown.join(", ")}. Known: ${file.cases.map((c) => c.id).join(", ")}`);
}

// Every input must exist before anything is paid for.
const missing = cases.flatMap((c) => (c.kind === "photos" ? [...c.photos, c.boq] : [c.pdf]).filter((p) => !existsSync(fromRoot(p))).map((p) => `${c.id}: ${p}`));
if (missing.length) {
  console.error(`Missing input files (paths are relative to the repo root):\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
const name = args.name?.replace(/[^\w-]+/g, "-");
const outDir = join(repoRoot, "samples", "out", "eval", name ? `${stamp}-${name}` : stamp);
await mkdir(outDir, { recursive: true });

// Before anything imports src/config.ts.
process.env.DATABASE_URL = "pglite:memory";
process.env.STORAGE_LOCAL_DIR = join(outDir, "storage");

const { env } = await import("../src/config.js");
const { db, schema } = await import("../src/db/client.js");
const { and, eq, inArray } = await import("drizzle-orm");
const { runDryRun } = await import("./dry-run.js");
const { rasterizePdf } = await import("../src/services/drawings/rasterize.js");
const { ImportCostMeter } = await import("../src/services/drawings/cost.js");
const { isStructural, runPipeline } = await import("../src/services/drawings/pipeline.js");
const { assembleProposal, runActions } = await import("../src/services/drawings/assemble.js");

const budget = new EvalBudget(maxCost);
const visitCap = env.MAX_COST_PER_VISIT_USD;
const importCap = env.MAX_COST_PER_DRAWING_IMPORT_USD;
const records: RunRecord[] = [];

console.log(`SiteSight eval · ${cases.length} case(s) × ${runs} run(s) · cap $${maxCost.toFixed(2)} · model ${env.SPARK_MODEL} · AGENT_FAST_PATH=${env.AGENT_FAST_PATH}`);
console.log(`Output: ${outDir}\n`);

async function runPhotoCase(c: PhotoCase, run: number, cap: number): Promise<RunRecord> {
  const runDir = join(outDir, "cases", c.id, `run-${run}`);
  const photosDir = join(runDir, "photos");
  await mkdir(photosDir, { recursive: true });
  for (const p of c.photos) await copyFile(fromRoot(p), join(photosDir, basename(p)));
  const log = (line: string) => void appendFile(join(runDir, "log.txt"), `${line}\n`);

  env.MAX_COST_PER_VISIT_USD = cap; // the visit's own cap, shrunk to what is left of the eval budget
  const started = Date.now();
  try {
    const summary = await runDryRun({ photosDir, boqPath: fromRoot(c.boq), outDir: runDir, out: log });
    const v = summary.visits[0]!;
    const runIds = (await db.select({ id: schema.agentRuns.id }).from(schema.agentRuns).where(eq(schema.agentRuns.visitId, v.visitId))).map((r) => r.id);
    const turns = runIds.length
      ? (await db.select({ id: schema.agentSteps.id }).from(schema.agentSteps).where(and(inArray(schema.agentSteps.runId, runIds), eq(schema.agentSteps.kind, "model")))).length
      : 0;
    const photos = await db.select().from(schema.photos).where(eq(schema.photos.visitId, v.visitId)).orderBy(schema.photos.id);
    const label = new Map(photos.map((p, i) => [p.id, basename(c.photos[i] ?? `photo ${p.id}`)]));
    const segs = (
      await Promise.all(photos.map((p) => db.select().from(schema.segments).where(eq(schema.segments.photoId, p.id))))
    ).flat();
    const output = {
      assessments: v.assessments.map((a) => ({ code: a.code, stageReached: a.stageReached, qtyDone: a.qtyDone, basis: a.basis })),
      itemStatus: Object.fromEntries(v.items.map((i) => [i.code, i.status])),
      detections: {
        total: segs.length,
        kept: segs.filter((s) => s.verified === true).length,
        rejected: segs.filter((s) => s.verified === false).length,
        unverified: segs.filter((s) => s.verified == null).length,
      },
      rejections: segs
        .filter((s) => s.verified === false)
        .map((s) => ({ segmentId: s.id, concept: s.concept, reason: s.rejectReason ?? "", photo: label.get(s.photoId) ?? `photo ${s.photoId}` })),
      outcome: v.outcome,
      error: v.error,
    };
    const { checks, rejectNotes } = scorePhotoRun(c, output);
    const failed = v.outcome === "failed";
    return {
      caseId: c.id,
      kind: "photos",
      run,
      labelledBy: c.labelled_by,
      status: failed ? "failed" : "done",
      reason: failed ? (v.error ?? "agent failed") : v.outcome !== "assessed" ? v.outcome : undefined,
      costUsd: v.costUsd,
      latencyMs: Date.now() - started,
      turns,
      checks,
      rejectNotes,
      detections: output.detections,
      rejections: output.rejections,
    };
  } catch (err) {
    return { caseId: c.id, kind: "photos", run, labelledBy: c.labelled_by, status: "failed", reason: err instanceof Error ? err.message : String(err), costUsd: 0, latencyMs: Date.now() - started, checks: [] };
  } finally {
    env.MAX_COST_PER_VISIT_USD = visitCap;
  }
}

async function runDrawingCase(c: DrawingCase, run: number, cap: number): Promise<RunRecord> {
  const started = Date.now();
  const meter = new ImportCostMeter(Math.min(importCap, cap));
  try {
    const pages = await rasterizePdf(await readFile(fromRoot(c.pdf)), { maxEdge: 2000, maxPages: env.DRAWING_MAX_PAGES });
    const states: { pageNo: number; classification: null | import("@sitesight/shared").PageClassification; extraction: null | import("@sitesight/shared").SheetExtraction; error: string | null }[] =
      pages.map((p) => ({ pageNo: p.pageNo, classification: null, extraction: null, error: null }));
    const { stoppedByCost } = await runPipeline(states, { png: async (n) => pages[n - 1]!.png }, meter, env.DRAWING_CONCURRENCY);
    // Nothing could be read (every page failed): a failed run, not a set of wrong answers.
    const unread = states.filter((st) => st.error);
    if (pages.length && unread.length === pages.length) throw new Error(`no page could be read (${unread[0]!.error})`);
    const proposal = assembleProposal(states);
    proposal.warnings.unshift(...runActions(states, stoppedByCost, meter.limitUsd, isStructural));
    const runDir = join(outDir, "cases", c.id, `run-${run}`);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "proposal.json"), JSON.stringify({ pages: states, proposal }, null, 2));
    const checks = scoreDrawingRun(c, {
      items: proposal.items.map((i) => ({ code: i.code, description: i.description, plannedQty: i.plannedQty, unit: i.unit, needsInput: i.needsInput })),
      actions: proposal.warnings.filter((w) => w.kind === "action").map((w) => w.text),
      error: null,
    });
    return {
      caseId: c.id,
      kind: "drawings",
      run,
      labelledBy: c.labelled_by,
      status: "done",
      reason: stoppedByCost ? "stopped at the cost cap" : undefined,
      costUsd: meter.spentUsd,
      latencyMs: Date.now() - started,
      checks,
    };
  } catch (err) {
    return { caseId: c.id, kind: "drawings", run, labelledBy: c.labelled_by, status: "failed", reason: err instanceof Error ? err.message : String(err), costUsd: meter.spentUsd, latencyMs: Date.now() - started, checks: [] };
  }
}

for (const c of cases) {
  for (let run = 1; run <= runs; run++) {
    const cap = budget.capFor(c.kind === "photos" ? visitCap : importCap);
    if (cap == null) {
      records.push({ caseId: c.id, kind: c.kind, run, labelledBy: c.labelled_by, status: "skipped", reason: "eval cost cap reached", costUsd: 0, latencyMs: 0, checks: [] });
      console.log(`  ${c.id} run ${run}: skipped (eval cost cap reached)`);
      continue;
    }
    process.stdout.write(`  ${c.id} run ${run}… `);
    const rec = c.kind === "photos" ? await runPhotoCase(c, run, cap) : await runDrawingCase(c, run, cap);
    budget.add(rec.costUsd);
    records.push(rec);
    const passed = rec.checks.filter((x) => x.pass).length;
    console.log(
      `${rec.status}${rec.reason ? ` (${rec.reason})` : ""} · ${passed}/${rec.checks.length} checks · $${rec.costUsd.toFixed(3)} · ${(rec.latencyMs / 1000).toFixed(0)} s · eval total $${budget.spentUsd.toFixed(2)}`,
    );
  }
}

const date = new Date().toISOString().slice(0, 10);
const meta = { runsPerCase: runs, model: env.SPARK_MODEL, date, maxCostUsd: maxCost, labelsNote: file.labels_note, outDir, name: name ?? null, fastPath: env.AGENT_FAST_PATH };
const summary = summarize(records);
const humanRecords = records.filter((r) => r.labelledBy === "human");
const humanCases = cases.filter((c) => c.labelled_by === "human").length;
const headline = humanCases ? summarize(humanRecords) : null;
await writeFile(
  join(outDir, "report.json"),
  JSON.stringify({ meta: { ...meta, humanCases }, cases: cases as EvalCase[], records, summary, headline, consistency: consistency(records) }, null, 2),
);
await writeFile(join(outDir, "report.md"), reportMarkdown(records, cases, meta));

console.log(`\n${headlineNote(humanCases, cases.length, runs)}`);
if (headline) console.log(`\n${summaryTable(headline, { ...meta, cases: humanCases })}\n`);
if (humanCases < cases.length) console.log(`\nAll cases incl. draft (not headline):\n${summaryTable(summary, { ...meta, cases: cases.length })}\n`);
console.log(`Report: ${join(outDir, "report.md")}`);
process.exit(0);
