// The agent dry run. Loaded by scripts/agent-dry-run.ts only after DATABASE_URL=pglite:memory and
// STORAGE_LOCAL_DIR are set, so everything below runs against an in-memory DB and local files.
import { readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { BoqItemInput } from "@sitesight/shared";
import { env } from "../src/config.js";
import { db, schema } from "../src/db/client.js";
import { runAgent } from "../src/agent/run.js";
import { onTraceStep } from "../src/agent/trace.js";
import { visitSpendUsd } from "../src/meta/cost.js";
import { parseBoq } from "../src/services/boq-parser.js";
import { boqItemProblem } from "../src/services/boq-rules.js";
import { boqItemStatus } from "../src/lib/item-status.js";
import { normalize } from "../src/services/images.js";
import { newKey, putObject } from "../src/services/storage.js";
import { formatTable } from "./spike-lib.js";
import {
  describeStep,
  discoverZones,
  parseBoqJson,
  progressRows,
  truncate,
  type BoqJson,
  type DiscoveredZone,
  type ProgressRow,
} from "./dry-run-lib.js";

export interface DryRunOptions {
  /** Visit folders, run in order on the same project. */
  visitDirs?: string[];
  /** Single-visit shorthand for visitDirs: [photosDir]. */
  photosDir?: string;
  boqPath: string;
  outDir: string;
  out?: (line: string) => void;
}

export interface VisitResult {
  index: number;
  dir: string;
  outcome: "assessed" | "needs_input" | "partial" | "failed";
  error: string | null;
  visitId: number;
  /** Every BOQ item with its status, e.g. "assessed" or "awaiting photo (ask-back #3)". */
  items: { code: string; description: string; status: string; openAskBackIds: number[] }[];
  assessments: {
    code: string;
    basis: "observed" | "inferred";
    percentComplete: number;
    stageReached: string | null;
    qtyDone: number | null;
    confidence: number;
    deviation: string | null;
    photoIds: number[];
    rationale: string;
  }[];
  askBacks: { id: number; zone: string; boqCode: string | null; instruction: string; reason: string; status: string }[];
  steps: number;
  costUsd: number;
  /** Change against the previous visit (empty for the first visit). */
  progress: ProgressRow[];
}

export interface DryRunSummary {
  visits: VisitResult[];
  costUsd: number;
}

const CONTENT_TYPE: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const money = (n: number) => `$${n.toFixed(4)}`;

export async function runDryRun(opts: DryRunOptions): Promise<DryRunSummary> {
  const out = opts.out ?? ((line: string) => console.log(line));
  const visitDirs = opts.visitDirs ?? (opts.photosDir ? [opts.photosDir] : []);
  if (!visitDirs.length) throw new Error("No visit folders given.");
  const multi = visitDirs.length > 1;

  // ---- inputs (all validated before anything is created or paid for) ----
  const boq = await loadBoq(opts.boqPath, out);
  const visitZones: DiscoveredZone[][] = [];
  for (const dir of visitDirs) {
    visitZones.push(await discoverZones(dir, { declaredZones: boq.zones, looseZoneName: multi ? "Site" : undefined }));
  }

  // ---- one project, zones, BOQ ----
  const [project] = await db
    .insert(schema.projects)
    .values({ name: `Dry run ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, locationLabel: "dry run" })
    .returning();
  const zoneNames = [...new Set([...(boq.zones ?? []), ...visitZones.flatMap((zs) => zs.map((z) => z.name))])];
  const zoneIds = new Map<string, number>();
  for (const [i, name] of zoneNames.entries()) {
    const [row] = await db.insert(schema.zones).values({ projectId: project!.id, name, sortOrder: i }).returning();
    zoneIds.set(name, row!.id);
  }
  const unknownZones = boq.items.filter((b) => b.zone && !zoneIds.has(b.zone)).map((b) => `${b.code} → "${b.zone}"`);
  if (unknownZones.length) {
    throw new Error(`BOQ items name zones that are not photo folders: ${unknownZones.join(", ")}. Folders: ${[...zoneIds.keys()].join(", ")}`);
  }
  await db.insert(schema.boqItems).values(
    boq.items.map(({ zone, ...item }) => ({ ...item, projectId: project!.id, zoneId: zone ? zoneIds.get(zone)! : null })),
  );

  out(`Dry run: project #${project!.id} (in-memory DB), ${visitDirs.length} visit(s). Budget cap ${money(env.MAX_COST_PER_VISIT_USD)} per visit.`);
  out(`Files: ${opts.outDir}`);
  out(`\nBOQ (${boq.items.length} items):`);
  for (const b of boq.items) {
    const how = b.measureMode === "visual_only" ? "visual only" : `${b.measureMode} via ${b.segmentTargets.join(", ")}`;
    const extra = [
      b.panelPlannedQty ? `panel ${b.panelPlannedQty} ${b.unit}` : null,
      b.stages ? `stages ${b.stages.map((s) => `${s.name} ${Math.round(s.weight * 100)}%`).join(" → ")}` : null,
    ].filter(Boolean);
    out(`  ${b.code}  ${b.description}  ${b.plannedQty} ${b.unit}  [${how}${extra.length ? `, ${extra.join(", ")}` : ""}]`);
  }

  // ---- visits, in order ----
  const results: VisitResult[] = [];
  for (const [index, dir] of visitDirs.entries()) {
    if (multi) out(`\n=== Visit ${index + 1}/${visitDirs.length}: ${dir} ===`);
    const previous = results.at(-1);
    if (previous) {
      // Simulate the engineer accepting the previous visit, so get_previous_assessment and the context see it.
      const accepted = await db
        .update(schema.assessments)
        .set({ status: "accepted" })
        .where(and(eq(schema.assessments.visitId, previous.visitId), eq(schema.assessments.status, "proposed")))
        .returning({ id: schema.assessments.id });
      await db.update(schema.visits).set({ status: "reviewed" }).where(eq(schema.visits.id, previous.visitId));
      out(`Accepted ${accepted.length} assessment(s) from visit ${index} (simulated engineer review).`);
    }

    const result = await runVisit(index, dir, project!.id, visitZones[index]!, zoneIds, out);
    if (previous) {
      result.progress = progressRows(toProgressInput(previous), toProgressInput(result));
      out(`\nProgress since last visit:`);
      out(
        formatTable(
          ["BOQ item", "previous", "now", "change"],
          [34, 30, 30, 40],
          result.progress.map((r) => [`${r.code} ${r.description}`, r.previous, r.now, r.change]),
        ),
      );
    }
    results.push(result);
  }

  const summary: DryRunSummary = { visits: results, costUsd: results.reduce((s, r) => s + r.costUsd, 0) };
  if (multi) {
    out(`\n=== All visits ===`);
    out(`Visits: ${results.length}   Steps: ${results.reduce((s, r) => s + r.steps, 0)}   Total cost: ${money(summary.costUsd)}`);
  }
  const reportPath = join(opts.outDir, "dry-run.json");
  await writeFile(reportPath, JSON.stringify({ boqPath: opts.boqPath, ...summary }, null, 2));
  out(`Full report (untruncated rationales): ${reportPath}`);
  return summary;
}

async function runVisit(
  index: number,
  dir: string,
  projectId: number,
  zones: DiscoveredZone[],
  zoneIds: Map<string, number>,
  out: (line: string) => void,
): Promise<VisitResult> {
  const [visit] = await db.insert(schema.visits).values({ projectId, status: "queued" }).returning();
  const visitId = visit!.id;
  out(`Visit #${visitId}. Photos:`);
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
  out("\n--- agent trace ---");

  const unsubscribe = onTraceStep(async (step) => {
    for (const line of describeStep(step)) out(line);
    const costly = step.kind === "model" || (step.kind === "tool_result" && (step.name === "segment_photo" || step.name === "measure"));
    if (costly) out(`     cost so far ${money(await visitSpendUsd(visitId))} / ${money(env.MAX_COST_PER_VISIT_USD)}`);
  });
  let outcome: VisitResult["outcome"];
  let error: string | null = null;
  try {
    outcome = await runAgent(visitId);
  } catch (err) {
    outcome = "failed";
    error = err instanceof Error ? err.message : String(err);
  } finally {
    unsubscribe();
  }

  const result = await collect(index, dir, visitId, outcome, error);
  out("\n--- results ---");
  out(`Outcome: ${outcome}${error ? ` (${error})` : ""}\n`);
  const items = await db.select().from(schema.boqItems).where(eq(schema.boqItems.projectId, projectId)).orderBy(schema.boqItems.id);
  out(
    formatTable(
      ["BOQ item", "status", "% done", "qty_done", "conf.", "evidence", "rationale"],
      [30, 40, 6, 12, 5, 9, 46],
      items.map((it) => {
        const a = result.assessments.find((x) => x.code === it.code);
        const status = result.items.find((x) => x.code === it.code)!.status;
        if (!a) {
          const ask = result.askBacks.find((x) => x.boqCode === it.code && x.status === "open");
          return [`${it.code} ${it.description}`, status, "—", "—", "—", "—", ask ? truncate(`requested: ${ask.instruction}`, 50) : "—"];
        }
        return [
          `${it.code} ${it.description}`,
          status,
          `${Math.round(a.percentComplete)}%`,
          a.qtyDone == null ? "—" : `${a.qtyDone} ${it.unit}`,
          a.confidence.toFixed(2),
          a.photoIds.join(", ") || "—",
          truncate(`${a.stageReached ? `[${a.stageReached}] ` : ""}${a.deviation ? `DEVIATION: ${a.deviation} ` : ""}${a.rationale}`, 50),
        ];
      }),
    ),
  );
  if (result.askBacks.length) {
    out("\nPhoto requests (ask-backs):");
    for (const ab of result.askBacks) {
      out(`  [${ab.status}] #${ab.id} ${ab.zone}${ab.boqCode ? ` (for ${ab.boqCode})` : ""}: ${ab.instruction}\n          why: ${ab.reason}`);
    }
  } else {
    out("\nNo photo requests.");
  }
  out(`\nTotal steps: ${result.steps}   Total cost: ${money(result.costUsd)}`);
  return result;
}

function toProgressInput(r: VisitResult) {
  return r.items.map((it) => {
    const a = r.assessments.find((x) => x.code === it.code);
    return { code: it.code, description: it.description, status: it.status, assessment: a ? { percentComplete: a.percentComplete, stageReached: a.stageReached } : null };
  });
}

async function loadBoq(path: string, out: (line: string) => void): Promise<BoqJson> {
  const ext = extname(path).toLowerCase();
  let boq: BoqJson;
  if (ext === ".json") {
    boq = parseBoqJson(await readFile(path, "utf8"));
  } else if (ext === ".xlsx") {
    out("Parsing BOQ spreadsheet with Muse Spark (not counted in the visit budget)…");
    const parsed = await parseBoq(await readFile(path));
    for (const w of parsed.warnings) out(`  BOQ warning: ${w}`);
    boq = { items: parsed.items.map(({ zoneId: _zone, ...rest }) => rest), zones: null };
  } else {
    throw new Error(`--boq must be a .json or .xlsx file, got "${path}"`);
  }
  const problems = boq.items.flatMap((it) => {
    const { zone: _zone, ...rest } = it;
    const p = boqItemProblem({ ...rest, zoneId: null } satisfies BoqItemInput);
    return p ? [`${it.code}: ${p}`] : [];
  });
  if (problems.length) throw new Error(`Inconsistent BOQ items:\n  ${problems.join("\n  ")}`);
  return boq;
}

async function collect(index: number, dir: string, visitId: number, outcome: VisitResult["outcome"], error: string | null): Promise<VisitResult> {
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
  const [visit] = await db.select().from(schema.visits).where(eq(schema.visits.id, visitId));
  const items = await db.select().from(schema.boqItems).where(eq(schema.boqItems.projectId, visit!.projectId)).orderBy(schema.boqItems.id);
  const codeOf = new Map(items.map((i) => [i.id, i.code]));
  // Open requests from any visit of the project count: an item can still be waiting on an earlier visit's ask-back.
  const openProjectAskBacks = await db
    .select({ id: schema.askBacks.id, boqItemId: schema.askBacks.boqItemId })
    .from(schema.askBacks)
    .innerJoin(schema.visits, eq(schema.visits.id, schema.askBacks.visitId))
    .where(and(eq(schema.visits.projectId, visit!.projectId), eq(schema.askBacks.status, "open")))
    .orderBy(schema.askBacks.id);

  return {
    index,
    dir,
    outcome,
    error,
    visitId,
    items: items.map((it) => {
      const openIds = openProjectAskBacks.filter((ab) => ab.boqItemId === it.id).map((ab) => ab.id);
      const assessment = rows.find((r) => r.a.boqItemId === it.id)?.a;
      return {
        code: it.code,
        description: it.description,
        status: boqItemStatus(!!assessment, openIds, assessment?.basis),
        openAskBackIds: openIds,
      };
    }),
    assessments: rows.map(({ a, code }) => ({
      code,
      basis: a.basis,
      percentComplete: a.percentComplete,
      stageReached: a.stageReached,
      qtyDone: a.qtyDone,
      confidence: a.confidence,
      deviation: a.deviation,
      photoIds: evidence.filter((e) => e.assessmentId === a.id).map((e) => e.photoId),
      rationale: a.rationale,
    })),
    askBacks: askBacks.map(({ ab, zone }) => ({
      id: ab.id,
      zone,
      boqCode: ab.boqItemId != null ? (codeOf.get(ab.boqItemId) ?? null) : null,
      instruction: ab.instruction,
      reason: ab.reason,
      status: ab.status,
    })),
    steps: runs.reduce((s, r) => s + r.steps, 0),
    costUsd: await visitSpendUsd(visitId),
    progress: [],
  };
}
