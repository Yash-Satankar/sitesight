/**
 * Copy the photos for the live demo recording into samples/out/to-phone/ with clear names, to send to a phone:
 *   pnpm prod-photos
 * Only real site photos (WhatsApp Image 2026-10-*.jpeg) are copied; samples/ is gitignored.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertRealSitePhoto, TO_PHONE } from "./seed-prod-lib.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = join(repoRoot, "samples", "out", "to-phone");
mkdirSync(outDir, { recursive: true });

let missing = 0;
for (const [name, src] of Object.entries(TO_PHONE)) {
  const from = join(repoRoot, src);
  if (!existsSync(from)) {
    console.error(`  missing: ${src}`);
    missing++;
    continue;
  }
  assertRealSitePhoto(from);
  copyFileSync(from, join(outDir, name));
  console.log(`  ${name}  ← ${src} (${Math.round(statSync(from).size / 1024)} KB)`);
}
console.log(missing ? `${missing} photo(s) missing` : `Copied to ${outDir}`);
process.exit(missing ? 1 : 0);
