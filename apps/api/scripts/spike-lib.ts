// Pure helpers for scripts/sam-spike.ts (argument parsing, filtering, summaries), kept separate so they're unit-tested.
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

export const DEFAULT_CONCEPTS = ["concrete column", "brick wall", "concrete slab", "steel rebar", "measuring tape"];

export const USAGE = `usage: pnpm sam-spike [--concepts "a,b,c"] [--dir <folder>] [--min-score <0..1>]

  --concepts   comma-separated SAM prompts (default: ${DEFAULT_CONCEPTS.join(", ")})
  --dir        folder of .jpg/.png/.webp photos, relative to where you ran pnpm (default: samples/)
  --min-score  drop instances scoring below this from the table and overlays (default: 0)
  A bare folder argument also works: pnpm sam-spike samples/x`;

export interface SpikeOptions {
  concepts: string[];
  dir: string | null;
  minScore: number;
  help: boolean;
}

/** Parse CLI args. Throws an Error with a readable message on bad input. */
export function parseSpikeArgs(argv: string[]): SpikeOptions {
  // `pnpm script -- --flag` forwards a literal "--"; parseArgs would treat everything after it as positional.
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      concepts: { type: "string" },
      dir: { type: "string" },
      "min-score": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (positionals.length > 1) throw new Error(`Unexpected arguments: ${positionals.slice(1).join(" ")}`);
  if (values.dir && positionals.length) throw new Error("Give the folder either as --dir or as a bare argument, not both.");

  const concepts = values.concepts === undefined ? DEFAULT_CONCEPTS : parseConcepts(values.concepts);
  if (!concepts.length) throw new Error("--concepts is empty. Example: --concepts \"brickwork,red brick masonry\"");

  let minScore = 0;
  if (values["min-score"] !== undefined) {
    minScore = Number(values["min-score"]);
    if (values["min-score"].trim() === "" || !Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
      throw new Error(`--min-score must be a number from 0 to 1, got "${values["min-score"]}"`);
    }
  }

  return { concepts, dir: values.dir ?? positionals[0] ?? null, minScore, help: values.help ?? false };
}

/** Split on commas, trim, drop empties and exact duplicates (order kept). */
export function parseConcepts(raw: string): string[] {
  return [...new Set(raw.split(",").map((c) => c.trim()).filter(Boolean))];
}

/**
 * Filename-safe, unique per exact concept string. The short hash keeps variants that slug the same
 * ("Brick wall" vs "brick-wall") from overwriting each other, including on case-insensitive disks.
 */
export function conceptSlug(concept: string): string {
  const base = concept
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  const hash = createHash("sha1").update(concept).digest("hex").slice(0, 6);
  return `${base || "concept"}-${hash}`;
}

export function overlayFilename(imageBaseName: string, concept: string, minScore: number): string {
  const min = minScore > 0 ? `__min${minScore}` : "";
  return `${imageBaseName}__${conceptSlug(concept)}${min}.png`;
}

export function splitByScore<T extends { score: number }>(items: T[], minScore: number): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const it of items) (it.score >= minScore ? kept : dropped).push(it);
  return { kept, dropped };
}

export interface SpikeRow {
  image: string;
  concept: string;
  ok: boolean;
  kept: number;
  dropped: number;
  /** Sum of kept instance scores, so summaries can compute instance-weighted means. */
  scoreSum: number;
  ms: number;
  error?: string;
}

export interface ConceptSummary {
  concept: string;
  imagesOk: number; // images where the SAM call succeeded
  imagesWithHit: number; // of those, images with ≥1 kept instance
  instances: number; // kept
  dropped: number;
  meanScore: number | null; // over kept instances
  errors: number;
  meanMs: number | null; // over successful calls
}

export function summarise(rows: SpikeRow[], concepts: string[]): ConceptSummary[] {
  return concepts.map((concept) => {
    const mine = rows.filter((r) => r.concept === concept);
    const ok = mine.filter((r) => r.ok);
    const instances = ok.reduce((a, r) => a + r.kept, 0);
    const scoreSum = ok.reduce((a, r) => a + r.scoreSum, 0);
    return {
      concept,
      imagesOk: ok.length,
      imagesWithHit: ok.filter((r) => r.kept > 0).length,
      instances,
      dropped: ok.reduce((a, r) => a + r.dropped, 0),
      meanScore: instances ? scoreSum / instances : null,
      errors: mine.length - ok.length,
      meanMs: ok.length ? ok.reduce((a, r) => a + r.ms, 0) / ok.length : null,
    };
  });
}

// ---- table formatting ----

export function pad(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);
}

export function formatTable(header: string[], widths: number[], body: string[][]): string {
  const line = (cells: string[]) => cells.map((c, i) => pad(c, widths[i]!)).join(" | ");
  return [line(header), widths.map((w) => "-".repeat(w)).join("-+-"), ...body.map(line)].join("\n");
}
