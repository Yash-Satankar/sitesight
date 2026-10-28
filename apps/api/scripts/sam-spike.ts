/**
 * DAY 1 spike: run SAM 3.1 on site photos, save mask overlays, and compare prompt variants.
 *
 *   pnpm sam-spike                                              # default 5 concepts on samples/
 *   pnpm sam-spike --concepts "brickwork,red brick masonry,exposed brick wall" --dir samples/x
 *   pnpm sam-spike --min-score 0.5                              # hide low-confidence instances
 *
 * Overlays: samples/out/<image>__<concept-slug>[__min<score>].png, so variant runs don't overwrite each other.
 * Each run also writes samples/out/run-<timestamp>.json (args, every row, per-concept summary).
 * samples/ is gitignored. Needs META_API_KEY + META_BASE_URL. No database required.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { env } from "../src/config.js";
import { segment } from "../src/meta/sam.js";
import { normalize } from "../src/services/images.js";
import { drawMasks } from "../src/services/overlay.js";
import {
  formatTable,
  overlayFilename,
  pad,
  parseSpikeArgs,
  splitByScore,
  summarise,
  USAGE,
  type SpikeOptions,
  type SpikeRow,
} from "./spike-lib.js";

let opts: SpikeOptions;
try {
  opts = parseSpikeArgs(process.argv.slice(2));
} catch (err) {
  console.error(`${err instanceof Error ? err.message : err}\n\n${USAGE}`);
  process.exit(1);
}
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
// Relative --dir is resolved from where pnpm was run (INIT_CWD), not from apps/api.
const inDir = opts.dir ? resolve(process.env.INIT_CWD ?? process.cwd(), opts.dir) : join(repoRoot, "samples");
const outDir = join(repoRoot, "samples", "out");

let files: string[];
try {
  files = (await readdir(inDir, { withFileTypes: true }))
    .filter((d) => d.isFile() && /\.(jpe?g|png|webp)$/i.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
} catch {
  console.error(`Cannot read folder ${inDir}`);
  process.exit(1);
}
if (!files.length) {
  console.error(`No .jpg/.png/.webp images found in ${inDir}`);
  process.exit(1);
}
await mkdir(outDir, { recursive: true });

console.log(`SAM spike: ${files.length} image(s) from ${inDir}`);
console.log(`concepts:  ${opts.concepts.map((c) => `"${c}"`).join(", ")}`);
console.log(`min score: ${opts.minScore}${opts.minScore > 0 ? " (lower instances dropped from table and overlays)" : ""}\n`);

const W = [28, 26, 5, 7, 10, 6];
console.log(formatTable(["image", "concept", "kept", "dropped", "mean score", "ms"], W, []));

const rows: SpikeRow[] = [];
let samCalls = 0;
let instancesSeen = 0;
let instancesWithScore = 0;

for (const file of files) {
  const name = basename(file, extname(file));
  let img: Awaited<ReturnType<typeof normalize>>;
  try {
    img = await normalize(await readFile(join(inDir, file)));
  } catch (err) {
    console.log(`${pad(file, W[0]!)} | could not load: ${err instanceof Error ? err.message : err}`);
    continue;
  }

  for (const concept of opts.concepts) {
    const started = Date.now();
    samCalls++;
    let row: SpikeRow;
    try {
      const segs = await segment(img.buffer, [concept]);
      const ms = Date.now() - started;
      instancesSeen += segs.length;
      instancesWithScore += segs.filter((s) => s.score > 0).length;

      const { kept, dropped } = splitByScore(segs, opts.minScore);
      const overlay = await drawMasks(
        img.buffer,
        kept.map((s) => ({ mask: s.mask, bbox: s.bbox, label: `${concept} #${s.instanceIdx} ${s.score.toFixed(2)}` })),
      );
      await writeFile(join(outDir, overlayFilename(name, concept, opts.minScore)), await sharp(overlay).png().toBuffer());
      row = { image: file, concept, ok: true, kept: kept.length, dropped: dropped.length, scoreSum: kept.reduce((a, s) => a + s.score, 0), ms };
    } catch (err) {
      row = {
        image: file,
        concept,
        ok: false,
        kept: 0,
        dropped: 0,
        scoreSum: 0,
        ms: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    rows.push(row);
    const mean = row.ok && row.kept ? (row.scoreSum / row.kept).toFixed(2) : "—";
    console.log(
      [file, concept, row.ok ? String(row.kept) : "ERR", row.ok ? String(row.dropped) : "", mean, String(row.ms)]
        .map((c, i) => pad(c, W[i]!))
        .join(" | "),
    );
  }
}

// ---- per-concept summary (compare prompt variants side by side) ----
const summary = summarise(rows, opts.concepts);
console.log(`\nPer-concept summary${opts.minScore > 0 ? ` (instances with score ≥ ${opts.minScore})` : ""}`);
console.log(
  formatTable(
    ["concept", "images hit", "instances", "dropped", "mean score", "errors", "avg ms"],
    [30, 10, 9, 7, 10, 6, 6],
    summary.map((s) => [
      s.concept,
      `${s.imagesWithHit}/${s.imagesOk}`,
      String(s.instances),
      String(s.dropped),
      s.meanScore == null ? "—" : s.meanScore.toFixed(2),
      String(s.errors),
      s.meanMs == null ? "—" : String(Math.round(s.meanMs)),
    ]),
  ),
);

const errors = rows.filter((r) => !r.ok);
console.log(`\n${"-".repeat(78)}`);
console.log(`total images:     ${files.length}`);
console.log(`total SAM calls:  ${samCalls} (${errors.length} failed)`);
console.log(
  `estimated cost:   $${(samCalls * env.SAM_USD_PER_IMAGE).toFixed(4)} (${samCalls} requests × SAM_USD_PER_IMAGE=$${env.SAM_USD_PER_IMAGE}, one image per request)`,
);
console.log(`overlays:         ${outDir}`);

if (instancesSeen > 0 && instancesWithScore === 0) {
  console.log(
    `\n⚠ SAM returned no confidence scores (all 0), so mean score is meaningless${opts.minScore > 0 ? " and --min-score dropped every instance" : ""}.`,
  );
}
if (errors.length) console.log(`\nfirst error: ${errors[0]!.image} / ${errors[0]!.concept}\n  ${errors[0]!.error}`);

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
const runFile = join(outDir, `run-${stamp}.json`);
await writeFile(
  runFile,
  JSON.stringify({ startedAt: new Date().toISOString(), dir: inDir, concepts: opts.concepts, minScore: opts.minScore, summary, rows }, null, 2),
);
console.log(`run log:          ${runFile}`);
