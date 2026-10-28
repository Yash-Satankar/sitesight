// The agent dry run. Loaded by scripts/agent-dry-run.ts only after DATABASE_URL=pglite:memory and
// STORAGE_LOCAL_DIR are set, so everything below runs against an in-memory DB and local files.
import { readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import type { BoqItemInput } from "@sitesight/shared";
import { env } from "../src/config.js";
import { db, schema } from "../src/db/client.js";
import { runAgent } from "../src/agent/run.js";
import { onTraceStep } from "../src/agent/trace.js";
import { visitSpendUsd } from "../src/meta/cost.js";
import { parseBoq } from "../src/services/boq-parser.js";
import { boqItemProblem } from "../src/services/boq-rules.js";
import { normalize } from "../src/services/images.js";
import { newKey, putObject } from "../src/services/storage.js";
import { formatTable } from "./spike-lib.js";
import { describeStep, discoverZones, parseBoqJson, truncate, type BoqJsonItem } from "./dry-run-lib.js";

export interface DryRunOptions {
  photosDir: string;
  boqPath: string;
  outDir: string;
  out?: (line: string) => void;
}

export interface DryRunSummary {
  outcome: "assessed" | "needs_input" | "partial" | "failed";
  error: string | null;
  visitId: number;
  assessments: { code: string; percentComplete: number; qtyDone: number | null; confidence: number; photoIds: number[]; rationale: string }[];
  askBacks: { zone: string; instruction: string; reason: string; status: string }[];
  steps: number;
  costUsd: number;
}

const CONTENT_TYPE: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

export async function runDryRun(opts: DryRunOptions): Promise<DryRunSummary> {
  const out = opts.out ?? ((line: string) => console.log(line));
  const money = (n: number) => `$${n.toFixed(4)}`;

  // ---- inputs ----
  const zones = await discoverZones(opts.photosDir);
  const boq = await loadBoq(opts.boqPath, out);

  // ---- throwaway project, zones, BOQ, visit, photos ----
  const [project] = await db
    .insert(schema.projects)
    .values({ name: `Dry run ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, locationLabel: "dry run" })
    .returning();
  const zoneIds = new Map<string, number>();
  for (const [i, z] of zones.entries()) {
    const [row] = await db.insert(schema.zones).values({ projectId: project!.id, name: z.name, sortOrder: i }).returning();
    zoneIds.set(z.name, row!.id);
  }
  const unknownZones = boq.filter((b) => b.zone && !zoneIds.has(b.zone)).map((b) => `${b.code} → "${b.zone}"`);
  if (unknownZones.length) {
    throw new Error(`BOQ items name zones that are not photo folders: ${unknownZones.join(", ")}. Folders: ${[...zoneIds.keys()].join(", ")}`);
  }
  await db.insert(schema.boqItems).values(
    boq.map(({ zone, ...item }) => ({ ...item, projectId: project!.id, zoneId: zone ? zoneIds.get(zone)! : null })),
  );
  const [visit] = await db.insert(schema.visits).values({ projectId: project!.id, status: "queued" }).returning();
  const visitId = visit!.id;

  out(`Dry run: project #${project!.id}, visit #${visitId} (in-memory DB). Budget cap ${money(env.MAX_COST_PER_VISIT_USD)}.`);
  out(`Files: ${opts.outDir}\n`);
  out("Photos:");
  for (const z of zones) {
    for (const p of z.photos) {
      const bytes = await readFile(p.path);
      const storageKey = newKey(`visits/${visitId}/photos`, CONTENT_TYPE[extname(p.file).toLowerCase()] ?? "image/jpeg");
      await putObject(storageKey, bytes, "application/octet-stream");
      const img = await normalize(bytes);
      const [row] = await db
        .insert(schema.photos)
        .values({ visitId, zoneId: zoneIds.get(z.name)!, storageKey, width: img.width, height: img.height, transcript: p.transcript })
        .returning();
      out(`  photo ${row!.id}: ${z.name} / ${p.file}${p.transcript ? `  (transcript: "${truncate(p.transcript, 60)}")` : ""}`);
    }
  }
  out(`\nBOQ (${boq.length} items):`);
  for (const b of boq) {
    const how = b.measureMode === "visual_only" ? "visual only" : `${b.measureMode} via ${b.segmentTargets.join(", ")}`;
    out(`  ${b.code}  ${b.description}  ${b.plannedQty} ${b.unit}  [${how}${b.panelPlannedQty ? `, panel ${b.panelPlannedQty} ${b.unit}` : ""}]`);
  }
  out("\n--- agent trace ---");

  // ---- run the real agent, streaming each step ----
  const unsubscribe = onTraceStep(async (step) => {
    for (const line of describeStep(step)) out(line);
    const costly = step.kind === "model" || (step.kind === "tool_result" && (step.name === "segment_photo" || step.name === "measure"));
    if (costly) out(`     cost so far ${money(await visitSpendUsd(visitId))} / ${money(env.MAX_COST_PER_VISIT_USD)}`);
  });
  let outcome: DryRunSummary["outcome"];
  let error: string | null = null;
  try {
    outcome = await runAgent(visitId);
  } catch (err) {
    outcome = "failed";
    error = err instanceof Error ? err.message : String(err);
  } finally {
    unsubscribe();
  }

  // ---- results ----
  const summary = await collect(visitId, outcome, error);
  out("\n--- results ---");
  out(`Outcome: ${outcome}${error ? ` (${error})` : ""}\n`);
  const items = await db.select().from(schema.boqItems).where(eq(schema.boqItems.projectId, project!.id)).orderBy(schema.boqItems.id);
  out(
    formatTable(
      ["BOQ item", "% done", "qty_done", "conf.", "evidence photos", "rationale"],
      [34, 6, 12, 5, 15, 60],
      items.map((it) => {
        const a = summary.assessments.find((x) => x.code === it.code);
        if (!a) return [`${it.code} ${it.description}`, "—", "—", "—", "—", "(not assessed)"];
        return [
          `${it.code} ${it.description}`,
          `${Math.round(a.percentComplete)}%`,
          a.qtyDone == null ? "—" : `${a.qtyDone} ${it.unit}`,
          a.confidence.toFixed(2),
          a.photoIds.join(", ") || "—",
          truncate(a.rationale, 60),
        ];
      }),
    ),
  );
  if (summary.askBacks.length) {
    out("\nPhoto requests (ask-backs):");
    for (const ab of summary.askBacks) out(`  [${ab.status}] ${ab.zone}: ${ab.instruction}\n          why: ${ab.reason}`);
  } else {
    out("\nNo photo requests.");
  }
  out(`\nTotal steps: ${summary.steps}   Total cost: ${money(summary.costUsd)}`);

  const reportPath = join(opts.outDir, "dry-run.json");
  await writeFile(reportPath, JSON.stringify({ photosDir: opts.photosDir, boqPath: opts.boqPath, ...summary }, null, 2));
  out(`Full report (untruncated rationales): ${reportPath}`);
  return summary;
}

async function loadBoq(path: string, out: (line: string) => void): Promise<BoqJsonItem[]> {
  const ext = extname(path).toLowerCase();
  let items: BoqJsonItem[];
  if (ext === ".json") {
    items = parseBoqJson(await readFile(path, "utf8"));
  } else if (ext === ".xlsx") {
    out("Parsing BOQ spreadsheet with Muse Spark (not counted in the visit budget)…");
    const parsed = await parseBoq(await readFile(path));
    for (const w of parsed.warnings) out(`  BOQ warning: ${w}`);
    items = parsed.items.map(({ zoneId: _zone, ...rest }) => rest);
  } else {
    throw new Error(`--boq must be a .json or .xlsx file, got "${path}"`);
  }
  const problems = items.flatMap((it) => {
    const p = boqItemProblem({ ...it, zoneId: null } satisfies BoqItemInput);
    return p ? [`${it.code}: ${p}`] : [];
  });
  if (problems.length) throw new Error(`Inconsistent BOQ items:\n  ${problems.join("\n  ")}`);
  return items;
}

async function collect(visitId: number, outcome: DryRunSummary["outcome"], error: string | null): Promise<DryRunSummary> {
  const rows = await db
    .select({ a: schema.assessments, code: schema.boqItems.code })
    .from(schema.assessments)
    .innerJoin(schema.boqItems, eq(schema.boqItems.id, schema.assessments.boqItemId))
    .where(eq(schema.assessments.visitId, visitId));
  const evidence = rows.length
    ? await db
        .select()
        .from(schema.assessmentEvidence)
        .where(inArray(schema.assessmentEvidence.assessmentId, rows.map((r) => r.a.id)))
    : [];
  const askBacks = await db
    .select({ ab: schema.askBacks, zone: schema.zones.name })
    .from(schema.askBacks)
    .innerJoin(schema.zones, eq(schema.zones.id, schema.askBacks.zoneId))
    .where(eq(schema.askBacks.visitId, visitId))
    .orderBy(schema.askBacks.id);
  const runs = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.visitId, visitId));

  return {
    outcome,
    error,
    visitId,
    assessments: rows.map(({ a, code }) => ({
      code,
      percentComplete: a.percentComplete,
      qtyDone: a.qtyDone,
      confidence: a.confidence,
      photoIds: evidence.filter((e) => e.assessmentId === a.id).map((e) => e.photoId),
      rationale: a.rationale,
    })),
    askBacks: askBacks.map(({ ab, zone }) => ({ zone, instruction: ab.instruction, reason: ab.reason, status: ab.status })),
    steps: runs.reduce((s, r) => s + r.steps, 0),
    costUsd: await visitSpendUsd(visitId),
  };
}
