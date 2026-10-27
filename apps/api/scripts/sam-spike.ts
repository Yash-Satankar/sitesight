/**
 * DAY 1 spike: run SAM 3.1 on site photos, save mask overlays, and print a quality/latency table.
 *
 *   pnpm sam-spike                  # every .jpg/.png/.webp in samples/
 *   pnpm sam-spike path/to/folder
 *
 * Overlays go to samples/out/<image>__<concept>.png (gitignored with the rest of samples/).
 * Needs META_API_KEY + META_BASE_URL. No database required.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { env } from "../src/config.js";
import { segment } from "../src/meta/sam.js";
import { normalize } from "../src/services/images.js";
import { drawMasks } from "../src/services/overlay.js";

const CONCEPTS = ["concrete column", "brick wall", "concrete slab", "steel rebar", "measuring tape"];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const inDir = process.argv[2] ? resolve(process.env.INIT_CWD ?? process.cwd(), process.argv[2]) : join(repoRoot, "samples");
const outDir = join(repoRoot, "samples", "out");

const files = (await readdir(inDir, { withFileTypes: true }))
  .filter((d) => d.isFile() && /\.(jpe?g|png|webp)$/i.test(d.name))
  .map((d) => d.name)
  .sort();
if (!files.length) {
  console.error(`No images found in ${inDir}`);
  process.exit(1);
}
await mkdir(outDir, { recursive: true });
console.log(`SAM spike: ${files.length} image(s) from ${inDir}\nconcepts: ${CONCEPTS.join(", ")}\n`);

interface Row {
  image: string;
  concept: string;
  instances: number | "ERR";
  meanScore: number | null;
  ms: number;
  error?: string;
}
const rows: Row[] = [];
let samCalls = 0;

for (const file of files) {
  const name = basename(file, extname(file));
  let img: Awaited<ReturnType<typeof normalize>>;
  try {
    img = await normalize(await readFile(join(inDir, file)));
  } catch (err) {
    rows.push({ image: file, concept: "(load)", instances: "ERR", meanScore: null, ms: 0, error: String(err) });
    continue;
  }

  for (const concept of CONCEPTS) {
    const started = Date.now();
    samCalls++;
    try {
      const segs = await segment(img.buffer, [concept]);
      const ms = Date.now() - started;
      const overlay = await drawMasks(
        img.buffer,
        segs.map((s) => ({ mask: s.mask, bbox: s.bbox, label: `${concept} #${s.instanceIdx} ${s.score.toFixed(2)}` })),
      );
      await writeFile(join(outDir, `${name}__${slug(concept)}.png`), await sharp(overlay).png().toBuffer());
      const meanScore = segs.length ? segs.reduce((a, s) => a + s.score, 0) / segs.length : null;
      rows.push({ image: file, concept, instances: segs.length, meanScore, ms });
    } catch (err) {
      rows.push({
        image: file,
        concept,
        instances: "ERR",
        meanScore: null,
        ms: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    printRow(rows[rows.length - 1]!);
  }
}

// ---- summary ----
const imagesProcessed = new Set(rows.filter((r) => r.instances !== "ERR").map((r) => r.image)).size;
const errors = rows.filter((r) => r.instances === "ERR");
console.log(`\n${"-".repeat(78)}`);
console.log(`total images:     ${files.length} (${imagesProcessed} with at least one successful call)`);
console.log(`total SAM calls:  ${samCalls} (${errors.length} failed)`);
console.log(
  `estimated cost:   $${(samCalls * env.SAM_USD_PER_IMAGE).toFixed(4)} (${samCalls} requests × SAM_USD_PER_IMAGE=$${env.SAM_USD_PER_IMAGE}, one image per request)`,
);
console.log(`                  ($${(files.length * env.SAM_USD_PER_IMAGE).toFixed(4)} if billed once per unique image)`);
console.log(`overlays:         ${outDir}`);
if (errors.length) {
  console.log(`\nfirst error: ${errors[0]!.image} / ${errors[0]!.concept}\n  ${errors[0]!.error}`);
}

function printRow(r: Row) {
  if (rows.length === 1) {
    console.log(`${pad("image", 28)} | ${pad("concept", 16)} | ${pad("instances", 9)} | ${pad("mean score", 10)} | ms`);
    console.log(`${"-".repeat(28)}-+-${"-".repeat(16)}-+-${"-".repeat(9)}-+-${"-".repeat(10)}-+------`);
  }
  console.log(
    `${pad(r.image, 28)} | ${pad(r.concept, 16)} | ${pad(String(r.instances), 9)} | ${pad(r.meanScore == null ? "—" : r.meanScore.toFixed(2), 10)} | ${r.ms}`,
  );
}

function pad(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);
}

function slug(s: string) {
  return s.replace(/\W+/g, "_");
}
