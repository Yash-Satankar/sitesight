// Helpers for scripts/agent-dry-run.ts. Must not import anything from src/: the CLI sets DATABASE_URL
// and STORAGE_LOCAL_DIR before src/config.ts is loaded, and an early import would connect to the real DB.
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { parseArgs } from "node:util";
import { BoqItemInput } from "@sitesight/shared";
import { z } from "zod";

export const DRY_RUN_USAGE = `usage: pnpm agent-dry-run (--photos <dir> | --visits <dir1,dir2,…>) --boq <file.json|file.xlsx>

  --photos   folder of site photos for one visit. Each subfolder with photos becomes a zone; photos
             directly in the folder go into one zone. Optional transcript: <photo>.txt next to it.
  --visits   comma-separated visit folders, run in order on the same project. Before each visit the
             previous visit's assessments are accepted (as an engineer would), so the agent sees them.
  --boq      BOQ as JSON (see samples/boq-demo.json, samples/boq-demo-residence.json) or .xlsx (parsed by Muse Spark).
             A JSON BOQ may declare "zones"; loose photos then go into its single zone.

Runs the real agent loop against Meta with an in-memory database (no Docker, API, worker or R2).
Spend is capped per visit by MAX_COST_PER_VISIT_USD. Output and masks go to samples/out/dry-run-<time>/.`;

export interface DryRunArgs {
  visits: string[];
  boq: string;
  help: boolean;
}

export function parseDryRunArgs(argv: string[]): DryRunArgs {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      photos: { type: "string" },
      visits: { type: "string", multiple: true },
      boq: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return { visits: [], boq: "", help: true };
  if (positionals.length) throw new Error(`Unexpected arguments: ${positionals.join(" ")}`);
  if (values.photos && values.visits?.length) throw new Error("Use either --photos (one visit) or --visits (several), not both.");
  const visits = values.photos ? [values.photos] : (values.visits ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  if (!visits.length) throw new Error("--photos <dir> or --visits <dir1,dir2,…> is required");
  if (!values.boq) throw new Error("--boq <file.json|file.xlsx> is required");
  return { visits, boq: values.boq, help: false };
}

/**
 * PowerShell turns an unquoted `--visits a,b` into one argument "a b". A visit argument that is not an existing
 * folder but whose space-separated parts all are is split into those parts. Paths with spaces that exist are
 * kept whole. Returns the folders, or throws naming the ones that do not exist.
 */
export function expandVisitDirs(visits: string[], isDir: (path: string) => boolean): string[] {
  const out: string[] = [];
  const missing: string[] = [];
  for (const v of visits) {
    if (isDir(v)) {
      out.push(v);
      continue;
    }
    const parts = v.split(/\s+/).filter(Boolean);
    if (parts.length > 1 && parts.every(isDir)) out.push(...parts);
    else missing.push(v);
  }
  if (missing.length) {
    throw new Error(
      `Visit folder not found: ${missing.map((m) => `"${m}"`).join(", ")}. In PowerShell, quote the list: --visits "samples/demo-residence/v1,samples/demo-residence/v2"`,
    );
  }
  return out;
}

// ---- photos → zones ----

const IMAGE = /\.(jpe?g|png|webp)$/i;

export interface DiscoveredPhoto {
  path: string;
  file: string;
  transcript: string | null;
}
export interface DiscoveredZone {
  name: string;
  photos: DiscoveredPhoto[];
}

export interface DiscoverOptions {
  /** Zones declared by the BOQ: subfolders must use these names; loose photos go to the only one. */
  declaredZones?: string[] | null;
  /** Zone name for loose photos when no zones are declared (default: the folder name). */
  looseZoneName?: string;
}

/** One zone per subfolder that contains photos, plus one for photos directly in `dir`. */
export async function discoverZones(dir: string, opts: DiscoverOptions = {}): Promise<DiscoveredZone[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const zones: DiscoveredZone[] = [];
  const rootPhotos = await photosIn(dir, entries.filter((e) => e.isFile()).map((e) => e.name));
  const subdirs = entries.filter((e) => e.isDirectory() && e.name !== "out" && !e.name.startsWith(".")).map((e) => e.name);
  const declared = opts.declaredZones?.length ? opts.declaredZones : null;

  for (const sub of subdirs.sort(naturalCompare)) {
    const photos = await photosIn(join(dir, sub), await readdir(join(dir, sub)));
    if (!photos.length) continue;
    if (declared && !declared.includes(sub)) {
      throw new Error(`Photo folder "${sub}" in ${dir} is not a zone declared in the BOQ (${declared.join(", ")}).`);
    }
    zones.push({ name: sub, photos });
  }
  if (rootPhotos.length) {
    let name: string;
    if (declared) {
      if (declared.length !== 1) {
        throw new Error(`Photos directly in ${dir} need a zone: put them in a subfolder named after one of ${declared.join(", ")}.`);
      }
      name = declared[0]!;
    } else {
      const base = opts.looseZoneName ?? basename(dir);
      name = zones.length ? `${base} (top folder)` : base;
    }
    const existing = zones.find((z) => z.name === name);
    if (existing) existing.photos.unshift(...rootPhotos);
    else zones.unshift({ name, photos: rootPhotos });
  }
  if (!zones.length) throw new Error(`No .jpg/.png/.webp photos found in ${dir} or its subfolders.`);
  return zones;
}

async function photosIn(dir: string, names: string[]): Promise<DiscoveredPhoto[]> {
  const out: DiscoveredPhoto[] = [];
  for (const file of names.filter((n) => IMAGE.test(n)).sort(naturalCompare)) {
    const path = join(dir, file);
    if (!(await stat(path)).isFile()) continue;
    out.push({ path, file, transcript: await readTranscript(dir, file) });
  }
  return out;
}

async function readTranscript(dir: string, file: string): Promise<string | null> {
  for (const candidate of [`${file}.txt`, `${basename(file, extname(file))}.txt`]) {
    try {
      const text = (await readFile(join(dir, candidate), "utf8")).trim();
      if (text) return text;
    } catch {
      // no sidecar
    }
  }
  return null;
}

function naturalCompare(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true });
}

// ---- BOQ JSON ----

export const BoqJsonItem = BoqItemInput.omit({ zoneId: true }).extend({
  /** Optional zone name (a photo subfolder). Omit to apply the item to every zone. */
  zone: z.string().min(1).optional(),
});
export type BoqJsonItem = z.infer<typeof BoqJsonItem>;

export interface BoqJson {
  items: BoqJsonItem[];
  /** Optional `"zones": [...]` declared in the file. */
  zones: string[] | null;
}

/** Accepts `[...items]` or `{ "zones"?: [...], "items": [...] }`. Throws one readable error listing every bad item. */
export function parseBoqJson(text: string): BoqJson {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`BOQ file is not valid JSON: ${(err as Error).message}`);
  }
  const list = Array.isArray(raw) ? raw : (raw as { items?: unknown })?.items;
  if (!Array.isArray(list) || !list.length) throw new Error('BOQ JSON must be an array of items or { "items": [...] }.');
  const zonesRaw = Array.isArray(raw) ? undefined : (raw as { zones?: unknown }).zones;
  const zones = zonesRaw === undefined ? null : z.array(z.string().trim().min(1)).min(1).safeParse(zonesRaw);
  if (zones && !zones.success) throw new Error('BOQ "zones" must be a non-empty list of zone names.');

  const items: BoqJsonItem[] = [];
  const errors: string[] = [];
  list.forEach((entry, i) => {
    const r = BoqJsonItem.safeParse(entry);
    if (r.success) items.push(r.data);
    else {
      const label = (entry as { code?: string })?.code ?? `#${i + 1}`;
      errors.push(`${label}: ${r.error.issues.map((iss) => `${iss.path.join(".") || "item"} ${iss.message}`).join("; ")}`);
    }
  });
  if (errors.length) throw new Error(`Invalid BOQ items:\n  ${errors.join("\n  ")}`);
  const declared = zones ? zones.data! : null;
  const unknown = declared ? items.filter((i) => i.zone && !declared.includes(i.zone)).map((i) => `${i.code} → "${i.zone}"`) : [];
  if (unknown.length) throw new Error(`BOQ items name zones not in "zones" (${declared!.join(", ")}): ${unknown.join(", ")}`);
  return { items, zones: declared };
}

// ---- progress between visits ----

export interface ProgressInput {
  code: string;
  description: string;
  status: string;
  assessment: { percentComplete: number; stageReached: string | null } | null;
}
export interface ProgressRow {
  code: string;
  description: string;
  previous: string;
  now: string;
  change: string;
}

/** Compare each BOQ item between two visits (same item order as `now`). */
export function progressRows(previous: ProgressInput[], now: ProgressInput[]): ProgressRow[] {
  const cell = (x: ProgressInput | undefined) =>
    !x ? "—" : x.assessment ? `${round1(x.assessment.percentComplete)}%${x.assessment.stageReached ? ` (${x.assessment.stageReached})` : ""}` : x.status;
  return now.map((n) => {
    const p = previous.find((x) => x.code === n.code);
    let change: string;
    if (p?.assessment && n.assessment) {
      const d = round1(n.assessment.percentComplete - p.assessment.percentComplete);
      change = d > 0.5 ? `+${d} pts` : d < -0.5 ? `${d} pts, went backwards (deviation)` : "no change";
    } else if (n.assessment) change = "new";
    else if (p?.assessment) change = "not assessed this visit";
    else change = "—";
    return { code: n.code, description: n.description, previous: cell(p), now: cell(n), change };
  });
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

// ---- console formatting ----

export function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function compact(v: unknown, n: number): string {
  return truncate(JSON.stringify(v) ?? "", n);
}

export interface StepLike {
  kind: string;
  name: string | null;
  payload: unknown;
}

/** Console lines for one trace step. */
export function describeStep(step: StepLike): string[] {
  const p = (step.payload ?? {}) as Record<string, unknown>;
  switch (step.kind) {
    case "model": {
      const text = typeof p.text === "string" ? p.text.trim() : "";
      const usage = p.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      const c = p.context as { turn?: number; max_turns?: number; images?: number } | undefined;
      const info = [
        c?.turn != null ? `turn ${c.turn}/${c.max_turns}` : null,
        usage ? `${usage.input_tokens ?? 0} in / ${usage.output_tokens ?? 0} out tokens` : null,
        c?.images != null ? `${c.images} image${c.images === 1 ? "" : "s"} in context` : null,
      ].filter(Boolean);
      return [`[model]${info.length ? ` (${info.join(", ")})` : ""}${text ? ` ${truncate(text, 600)}` : ""}`];
    }
    case "notice":
      return [`  [notice: ${step.name}] ${truncate(String(p.message ?? ""), 400)}`];
    case "tool_call":
      return [`  -> ${step.name}(${compact(step.payload, 300)})`];
    case "tool_result":
      return [`  <- ${step.name}: ${describeResult(step.name, p)}`];
    case "rejection":
      return [`     x rejected segment #${p.segment_id} (${p.target}) on photo ${p.photo_id}: ${p.reason}`];
    case "error":
      return [`!! ${String(p.message ?? "run failed")}`];
    default:
      return [`  [${step.kind}] ${compact(step.payload, 300)}`];
  }
}

function describeResult(name: string | null, p: Record<string, unknown>): string {
  if (typeof p.error === "string") return `ERROR ${truncate(p.error, 400)}`;
  switch (name) {
    case "verify_segments":
      return `kept [${(p.kept as number[]).join(", ")}], rejected [${(p.rejected as number[]).join(", ")}], still unverified [${(p.unverified_remaining as number[]).join(", ")}]`;
    case "segment_photo":
      return ((p.targets as { target: string; instances: { segment_id: number; score: number }[] }[]) ?? [])
        .map((t) => `${t.target}: ${t.instances.length} instance(s) ${t.instances.map((i) => `#${i.segment_id}@${i.score}`).join(" ")}`)
        .join("; ");
    case "view_photo":
      return `photo ${p.photo_id} (${p.width}×${p.height}), ${(p.mask_legend as unknown[] | undefined)?.length ?? 0} mask(s) shown${p.panel ? `, panel ${compact(p.panel, 120)}` : ""}`;
    case "measure":
      return p.mode === "panel"
        ? `panel fraction ${p.fraction} (${p.covered_area_px}/${p.panel_area_px} px), measurement #${p.measurement_id}${(p.warnings as string[]).length ? `, warnings: ${(p.warnings as string[]).join(" | ")}` : ""}`
        : `count ${p.count}, area ${p.area_m2 ?? "n/a"} m², scale confidence ${p.scale_confidence}`;
    case "record_assessment":
      return `assessment #${p.assessment_id}, qty_done ${p.qty_done ?? "—"}, confidence ${p.confidence}${(p.notes as string[] | undefined)?.length ? `, notes: ${(p.notes as string[]).join(" | ")}` : ""}`;
    default:
      return compact(p, 300);
  }
}
