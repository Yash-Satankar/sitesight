// Helpers for scripts/agent-dry-run.ts. Must not import anything from src/: the CLI sets DATABASE_URL
// and STORAGE_LOCAL_DIR before src/config.ts is loaded, and an early import would connect to the real DB.
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { parseArgs } from "node:util";
import { BoqItemInput } from "@sitesight/shared";
import { z } from "zod";

export const DRY_RUN_USAGE = `usage: pnpm agent-dry-run --photos <dir> --boq <file.json|file.xlsx>

  --photos   folder of site photos. Each subfolder with photos becomes a zone; photos directly in
             the folder go into one zone named after it. Optional transcript: <photo>.txt next to it.
  --boq      BOQ as JSON (see samples/boq-demo.json) or .xlsx (parsed by Muse Spark first).

Runs the real agent loop against Meta with an in-memory database (no Docker, API, worker or R2).
Spend is capped by MAX_COST_PER_VISIT_USD. Output and stored masks go to samples/out/dry-run-<time>/.`;

export interface DryRunArgs {
  photos: string;
  boq: string;
  help: boolean;
}

export function parseDryRunArgs(argv: string[]): DryRunArgs {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { photos: { type: "string" }, boq: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) return { photos: "", boq: "", help: true };
  if (positionals.length) throw new Error(`Unexpected arguments: ${positionals.join(" ")}`);
  if (!values.photos) throw new Error("--photos <dir> is required");
  if (!values.boq) throw new Error("--boq <file.json|file.xlsx> is required");
  return { photos: values.photos, boq: values.boq, help: false };
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

/** One zone per subfolder that contains photos, plus one for photos directly in `dir`. */
export async function discoverZones(dir: string): Promise<DiscoveredZone[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const zones: DiscoveredZone[] = [];
  const rootPhotos = await photosIn(dir, entries.filter((e) => e.isFile()).map((e) => e.name));
  const subdirs = entries.filter((e) => e.isDirectory() && e.name !== "out" && !e.name.startsWith(".")).map((e) => e.name);

  for (const sub of subdirs.sort(naturalCompare)) {
    const photos = await photosIn(join(dir, sub), await readdir(join(dir, sub)));
    if (photos.length) zones.push({ name: sub, photos });
  }
  if (rootPhotos.length) zones.unshift({ name: zones.length ? `${basename(dir)} (top folder)` : basename(dir), photos: rootPhotos });
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

/** Accepts `[...items]` or `{ "items": [...] }`. Throws one readable error listing every bad item. */
export function parseBoqJson(text: string): BoqJsonItem[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`BOQ file is not valid JSON: ${(err as Error).message}`);
  }
  const list = Array.isArray(raw) ? raw : (raw as { items?: unknown })?.items;
  if (!Array.isArray(list) || !list.length) throw new Error('BOQ JSON must be an array of items or { "items": [...] }.');

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
  return items;
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
      const tokens = usage ? ` (${usage.input_tokens ?? 0} in / ${usage.output_tokens ?? 0} out tokens)` : "";
      return [`[model]${tokens}${text ? ` ${truncate(text, 600)}` : ""}`];
    }
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
