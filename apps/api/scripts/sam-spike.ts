/**
 * DAY 1 spike: run SAM 3.1 on real site photos and save masks + overlays to disk.
 *
 *   pnpm sam-spike <photo-dir> [concept ...]
 *   pnpm sam-spike ../../samples/photos "concrete column" "brick wall"
 *
 * Output goes to apps/api/spike-out/. Use it to decide go/no-go on segmentation quality.
 * Needs META_API_KEY + META_BASE_URL, and meta/sam.ts wired to the real API shape.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { segment } from "../src/meta/sam.js";
import { normalize } from "../src/services/images.js";
import { drawMasks } from "../src/services/overlay.js";

const [dirArg, ...conceptArgs] = process.argv.slice(2);
if (!dirArg) {
  console.error("usage: pnpm sam-spike <photo-dir> [concept ...]");
  process.exit(1);
}
const concepts = conceptArgs.length ? conceptArgs : ["concrete column", "brick wall", "A4 sheet of paper"];
const outDir = resolve("spike-out");

const files = (await readdir(resolve(dirArg))).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).slice(0, 20);
await mkdir(outDir, { recursive: true });
console.log(`Segmenting ${files.length} photos for: ${concepts.join(", ")}`);

const summary: Record<string, Record<string, number>> = {};
for (const file of files) {
  const name = basename(file, extname(file));
  const started = Date.now();
  try {
    const img = await normalize(await readFile(join(resolve(dirArg), file)));
    const segs = await segment(img.buffer, concepts);
    summary[file] = Object.fromEntries(concepts.map((c) => [c, segs.filter((s) => s.concept === c).length]));

    for (const s of segs) {
      await writeFile(join(outDir, `${name}__${s.concept.replace(/\W+/g, "_")}_${s.instanceIdx}.png`), s.mask);
    }
    const overlay = await drawMasks(
      img.buffer,
      segs.map((s) => ({ mask: s.mask, bbox: s.bbox, label: `${s.concept} ${s.score.toFixed(2)}` })),
    );
    await writeFile(join(outDir, `${name}__overlay.jpg`), overlay);
    console.log(`✓ ${file} (${Date.now() - started} ms)`, summary[file]);
  } catch (err) {
    console.error(`✗ ${file}:`, err instanceof Error ? err.message : err);
  }
}

await writeFile(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`Done. See ${outDir}`);
